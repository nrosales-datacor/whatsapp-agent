import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { crearTenant } from "../helpers/fixtures";
import { waConversaciones, waJobs, waMensajes, waUsoMensual } from "../../src/db/schema";
import {
  antiguedadPendienteMasViejoMin,
  emitirAlertas,
  estaEnHorario,
  evaluarVigilancia,
  jobsEnErrorRecientes,
  minutosHabilesEntre,
  tenantsConCuotaAgotada,
  tenantsSinEntrantes,
  type UmbralesVigilancia,
} from "../../src/observabilidad/vigilancia";
import { _configurarEnvioWebhookParaTests, _resetAlertasParaTests } from "../../src/observabilidad/alertas";
import { _resetTokensInvalidosParaTests, registrarRespuestaGraph } from "../../src/whatsapp/estadoToken";
import { anioMesActual } from "../../src/observabilidad/uso";
import { TOPE_CONVERSACIONES_MES } from "../../src/billing/planes";
import { chequearSalud } from "../../src/salud";
import { _forzarFuenteParaTests } from "../../src/config/tenantStore";
import type { Conversacion, PendienteSerializado } from "../../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// Detectores de "bot mudo" (observabilidad/vigilancia.ts) contra Postgres real
// (PGlite): cola atascada, DLQ reciente, tenant sin entrantes en horario hábil,
// cuota agotada, y la emisión deduplicada de alertas.
//
// El fixture de tenant tiene horario L-V 07:00-17:00, S 07:00-13:00, D cerrado,
// zona America/Costa_Rica (UTC-6 todo el año, sin horario de verano).
// ─────────────────────────────────────────────────────────────────────────────

function payload(tenantId: string): PendienteSerializado {
  const conv: Conversacion = {
    id: "conv-vig",
    tenantId,
    clienteWa: "50600000000",
    optInEn: null,
    optOutEn: null,
    modo: "bot",
    estado: "abierta",
    mensajes: [],
    ventanaAbierta: false,
    ventanaCierraEn: null,
  };
  return {
    clase: "texto",
    tenantId,
    entrante: { phoneNumberId: "pnid-vig", clienteWa: conv.clienteWa, esTexto: true, texto: "hola" },
    conv,
    primerContacto: false,
  };
}

const MIN = 60_000;
const haceMin = (m: number) => new Date(Date.now() - m * MIN);

/** Inserta un job (el id lo genera drizzle en JS, no hay default en la base). */
async function job(
  db: Awaited<ReturnType<typeof crearDbEfimera>>["db"],
  tenantId: string,
  campos: Partial<typeof waJobs.$inferInsert> = {},
): Promise<void> {
  await db.insert(waJobs).values({ tenantId, payload: payload(tenantId), estado: "pendiente", ...campos });
}

const UMBRALES: UmbralesVigilancia = { colaAtascadaMin: 10, dlqVentanaMin: 60, dlqUmbral: 1, sinEntrantesHoras: 4 };

// Martes 2026-09-29 11:00 en Costa Rica = 17:00Z (abierto, L-V 07-17).
const MARTES_11AM_CR = new Date("2026-09-29T17:00:00Z");

let webhooks: string[] = [];
beforeEach(() => {
  _resetAlertasParaTests();
  _resetTokensInvalidosParaTests();
  webhooks = [];
  _configurarEnvioWebhookParaTests(async (_url, c) => {
    webhooks.push(c.text);
  });
  process.env.ALERTAS_WEBHOOK_URL = "https://hooks.ejemplo.test/x";
});
afterEach(() => {
  _configurarEnvioWebhookParaTests(null);
  delete process.env.ALERTAS_WEBHOOK_URL;
});

// ── Horario hábil (puro) ────────────────────────────────────────────────────

test("minutosHabilesEntre: solo cuenta tiempo con el local abierto, en la zona del negocio", () => {
  const t = crearTenant();
  // Lunes 16:00 CR → martes 09:00 CR: 1 h del lunes (16-17) + 2 h del martes (07-09).
  const desde = new Date("2026-09-28T22:00:00Z");
  const hasta = new Date("2026-09-29T15:00:00Z");
  assert.equal(minutosHabilesEntre(desde, hasta, t), 180);

  // Sábado 12:00 CR → lunes 08:00 CR: 1 h del sábado (cierra 13:00), domingo cerrado, 1 h del lunes.
  assert.equal(minutosHabilesEntre(new Date("2026-09-26T18:00:00Z"), new Date("2026-09-28T14:00:00Z"), t), 120);

  // Un feriado (bloqueo) no cuenta como hábil.
  const conFeriado = crearTenant({ bloqueos: [{ desde: "2026-09-29", hasta: "2026-09-29", motivo: "feriado" }] });
  assert.equal(minutosHabilesEntre(desde, hasta, conFeriado), 60);

  // Rango invertido o vacío.
  assert.equal(minutosHabilesEntre(hasta, desde, t), 0);
});

test("estaEnHorario: respeta horario semanal y zona horaria", () => {
  const t = crearTenant();
  assert.equal(estaEnHorario(MARTES_11AM_CR, t), true);
  assert.equal(estaEnHorario(new Date("2026-09-30T03:00:00Z"), t), false, "martes 21:00 CR: cerrado");
  assert.equal(estaEnHorario(new Date("2026-09-27T17:00:00Z"), t), false, "domingo: cerrado");
});

// ── Detectores contra Postgres ──────────────────────────────────────────────

test("cola atascada: mide el pendiente LISTO más viejo; los diferidos (backoff) no cuentan", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    assert.equal(await antiguedadPendienteMasViejoMin(db), null, "sin pendientes");

    await job(db, "t1");
    await job(db, "t1", { ejecutarDespuesDe: new Date(Date.now() + 120 * MIN) }); // diferido por backoff
    const fresco = await antiguedadPendienteMasViejoMin(db);
    assert.ok(fresco !== null && fresco < 1, "el job recién encolado no está atascado; el diferido se ignora");

    await job(db, "t1", { ejecutarDespuesDe: haceMin(30) });
    const viejo = await antiguedadPendienteMasViejoMin(db);
    assert.ok(viejo !== null && viejo >= 29 && viejo <= 31, `esperaba ~30 min, fue ${viejo}`);

    const r = await evaluarVigilancia(db, { tenants: [], umbrales: UMBRALES });
    assert.equal(r.colaAtascada?.atascada, true);
    assert.equal(r.ok, false);
  } finally {
    await cerrar();
  }
});

test("DLQ reciente: cuenta por tenant solo los jobs en error dentro de la ventana", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    await job(db, "t1", { estado: "error", finalizadoEn: haceMin(5) });
    await job(db, "t1", { estado: "error", finalizadoEn: haceMin(10) });
    await job(db, "t2", { estado: "error", finalizadoEn: haceMin(180) }); // fuera de la ventana
    await job(db, "t3", { estado: "hecho", finalizadoEn: haceMin(1) }); // no es DLQ
    assert.deepEqual(await jobsEnErrorRecientes(db, 60), [{ tenantId: "t1", n: 2 }]);

    const r = await evaluarVigilancia(db, { tenants: [], umbrales: { ...UMBRALES, dlqUmbral: 3 } });
    assert.deepEqual(r.dlqReciente?.tenants, [], "2 errores no llegan a un umbral de 3");
  } finally {
    await cerrar();
  }
});

test("tenant sin entrantes: alerta solo si está abierto y lleva N horas HÁBILES en silencio", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const callado = crearTenant({ id: "callado", phoneNumberId: "p1" });
    const activo = crearTenant({ id: "activo", phoneNumberId: "p2" });
    const nuevo = crearTenant({ id: "nuevo", phoneNumberId: "p3" }); // sin ningún entrante: sin línea base
    const soloHistorico = crearTenant({ id: "historico", phoneNumberId: "p4" }); // sin jobs, sí mensajes viejos
    const cancelado = crearTenant({ id: "cancelado", phoneNumberId: "p5", estadoFacturacion: "cancelado" });

    // "callado": último entrante el lunes 15:00 CR → al martes 11:00 hay 2 h (lunes) + 4 h (martes) = 6 h hábiles.
    // "activo": último entrante hace 30 min.
    await job(db, "callado", { estado: "hecho", creadoEn: new Date("2026-09-28T21:00:00Z") });
    await job(db, "activo", { estado: "hecho", creadoEn: new Date("2026-09-28T21:00:00Z") });
    await job(db, "activo", { estado: "hecho", creadoEn: new Date("2026-09-29T16:30:00Z") });
    await job(db, "cancelado", { estado: "hecho", creadoEn: new Date("2026-09-20T16:30:00Z") });
    // "historico": nada en wa_jobs (fuera de la retención), pero un mensaje del cliente el viernes anterior.
    const [conv] = await db.insert(waConversaciones).values({ tenantId: "historico", clienteWa: "50611112222" }).returning();
    await db.insert(waMensajes).values([
      { tenantId: "historico", conversacionId: conv.id, rol: "user", contenido: "hola", creadoEn: new Date("2026-09-25T15:00:00Z") },
      { tenantId: "historico", conversacionId: conv.id, rol: "assistant", contenido: "¡hola!", creadoEn: new Date("2026-09-29T16:00:00Z") },
    ]);

    const tenants = [callado, activo, nuevo, soloHistorico, cancelado];
    const r = await tenantsSinEntrantes(db, tenants, 4, MARTES_11AM_CR);
    const ids = r.map((x) => x.tenantId).sort();
    assert.deepEqual(ids, ["callado", "historico"], "ni el activo, ni el nuevo sin línea base, ni el cancelado");
    assert.equal(r.find((x) => x.tenantId === "callado")?.horasHabiles, 6);

    // Fuera de horario (martes 21:00 CR) el silencio es normal: no alerta a nadie.
    assert.deepEqual(await tenantsSinEntrantes(db, tenants, 4, new Date("2026-09-30T03:00:00Z")), []);
    // Umbral 0 = detector apagado.
    assert.deepEqual(await tenantsSinEntrantes(db, tenants, 0, MARTES_11AM_CR), []);
  } finally {
    await cerrar();
  }
});

test("cuota agotada: detecta tenants al 100% del tope de su plan (y respeta Pro/interruptor)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const tope = TOPE_CONVERSACIONES_MES.basico!;
    const lleno = crearTenant({ id: "lleno", plan: "basico" });
    const a80 = crearTenant({ id: "a80", plan: "basico" });
    const pro = crearTenant({ id: "pro", plan: "pro" });
    const exento = crearTenant({ id: "exento", plan: "basico", topeConversacionesDesactivado: true });
    const mes = anioMesActual();
    await db.insert(waUsoMensual).values([
      { tenantId: "lleno", anioMes: mes, conversacionesIniciadas: tope },
      { tenantId: "a80", anioMes: mes, conversacionesIniciadas: Math.floor(tope * 0.8) },
      { tenantId: "pro", anioMes: mes, conversacionesIniciadas: tope * 3 },
      { tenantId: "exento", anioMes: mes, conversacionesIniciadas: tope * 2 },
      { tenantId: "lleno", anioMes: "2000-01", conversacionesIniciadas: 0 }, // otro mes: no interfiere
    ]);
    const r = await tenantsConCuotaAgotada(db, [lleno, a80, pro, exento]);
    assert.deepEqual(r, [{ tenantId: "lleno", usados: tope, tope }]);
  } finally {
    await cerrar();
  }
});

test("emitirAlertas: una alerta por hallazgo y deduplicada en el tick siguiente", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const tope = TOPE_CONVERSACIONES_MES.basico!;
    const lleno = crearTenant({ id: "lleno", plan: "basico" });
    await db.insert(waUsoMensual).values({ tenantId: "lleno", anioMes: anioMesActual(), conversacionesIniciadas: tope });
    await job(db, "lleno", { estado: "error", finalizadoEn: haceMin(1) });
    await job(db, "lleno", { ejecutarDespuesDe: haceMin(45) }); // pendiente atascado

    const r = await evaluarVigilancia(db, { tenants: [lleno], umbrales: UMBRALES, ahora: MARTES_11AM_CR });
    assert.equal(r.ok, false);
    assert.equal(emitirAlertas(r, 1_000), 3, "cola atascada + DLQ + cuota agotada");
    assert.equal(webhooks.length, 3);
    assert.ok(webhooks.some((t) => /cola_atascada/.test(t)));
    assert.ok(webhooks.some((t) => /dlq_reciente · tenant lleno/.test(t)));
    assert.ok(webhooks.some((t) => /cuota_agotada · tenant lleno/.test(t)));
    for (const t of webhooks) assert.doesNotMatch(t, /50600000000/, "sin teléfonos en las alertas");

    // Próximo tick (5 min después): mismo estado, cero alertas nuevas.
    assert.equal(emitirAlertas(r, 1_000 + 5 * 60_000), 0);
    assert.equal(webhooks.length, 3);
  } finally {
    await cerrar();
  }
});

test("/salud?detalle=1: incluye el resumen de vigilancia (con token inválido marcado) sin cambiar el 200", async () => {
  const { db, cerrar } = await crearDbEfimera();
  const previo = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://fake-para-hayBaseDeDatos-vigilancia";
  try {
    _forzarFuenteParaTests("db");
    registrarRespuestaGraph("tenant-revocado", false, 401, JSON.stringify({ error: { code: 190 } }));

    const sinDetalle = await chequearSalud(db);
    assert.equal(sinDetalle.vigilancia, undefined, "el GET plano del uptime monitor no corre los detectores");

    const detalle = await chequearSalud(db, { incluirVigilancia: true });
    assert.equal(detalle.ok, true, "la vigilancia es informativa: no convierte el 200 en 503");
    const v = detalle.vigilancia as Awaited<ReturnType<typeof evaluarVigilancia>>;
    assert.equal(v.ok, false);
    assert.deepEqual(v.tokensInvalidos.map((t) => t.tenantId), ["tenant-revocado"]);
    assert.ok(v.colaAtascada !== null && v.dlqReciente !== null && v.sinEntrantes !== null && v.cuotaAgotada !== null);
  } finally {
    if (previo === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previo;
    await cerrar();
  }
});
