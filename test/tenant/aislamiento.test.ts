import assert from "node:assert/strict";
import { test } from "node:test";
import { RepositorioEnMemoria } from "../../src/booking/inMemoryRepository";
import type { Cita, PushSub, Repositorio } from "../../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// Ángulo 2 de TESTING.md — INVARIANTE MULTI-TENANT (seguridad, no cosmético).
//
// Con 2 tenants sembrados en el repo en memoria, ninguna operación del tenant A
// debe ver ni escribir datos del B. Una fuga acá es un INCIDENTE. Por eso se
// recorre CADA método del Repositorio scopeado por tenant con el tenantId
// equivocado y se espera vacío / null / no-op.
//
// Alcance: RepositorioEnMemoria cubre conversaciones, citas, ficha, métricas y
// push subs. Usuarios / config / campañas viven fuera de este repo (auth y stores
// propios) y se cubren en el panel E2E (ángulo 6, guards de rol 403).
// ─────────────────────────────────────────────────────────────────────────────

const A = "tenant-A";
const B = "tenant-B";
// MISMO número de cliente en ambos tenants: la prueba más dura de la clave
// `tenantId:clienteWa`. Dos negocios pueden atender al mismo teléfono sin cruzarse.
const CLIENTE = "50611112222";
const HOY = "2026-07-14";
const FUTURO = "2026-08-01";

/** Convención del repo en memoria: el id de conversación es `tenantId:clienteWa`. */
const convId = (tenantId: string) => `${tenantId}:${CLIENTE}`;

/** Siembra una conversación + un mensaje + una cita futura + una push sub por tenant. */
async function sembrarTenant(repo: Repositorio, tenantId: string, servicioId: string): Promise<Cita> {
  await repo.obtenerOConversacion(tenantId, CLIENTE);
  await repo.guardarMensaje(convId(tenantId), {
    rol: "user",
    contenido: `hola desde ${tenantId}`,
    creadoEn: `${HOY}T10:00:00.000Z`,
  });
  const cita = await repo.crearCita({
    tenantId,
    clienteWa: CLIENTE,
    clienteNombre: `Cliente ${tenantId}`,
    servicioId,
    fecha: FUTURO,
    hora: "09:00",
    precio: 5000,
  });
  const sub: PushSub = { endpoint: `https://push/${tenantId}`, p256dh: "k", auth: "a" };
  await repo.guardarPushSub(tenantId, sub);
  return cita;
}

// ── Lecturas: sembrar SOLO A y consultar como B debe dar vacío/null ──

test("lectura: un tenant sin datos no ve NADA del otro (todas las lecturas scopeadas)", async () => {
  const repo = new RepositorioEnMemoria();
  await sembrarTenant(repo, A, "lavado-basico");
  // B jamás fue sembrado: toda lectura suya debe venir vacía.

  assert.deepEqual(await repo.citasPorFecha(B, FUTURO), []);
  assert.deepEqual(await repo.citasEnRango(B, HOY, "2026-12-31"), []);
  assert.deepEqual(await repo.citasActivasCliente(B, CLIENTE, HOY), []);
  assert.deepEqual(await repo.listarConversaciones(B), []);
  assert.equal(await repo.obtenerConversacionPorId(B, convId(A)), null);
  assert.equal(await repo.obtenerModo(B, convId(A)), null);
  assert.equal(await repo.fichaCliente(B, CLIENTE), null);
  assert.deepEqual(await repo.listarPushSubs(B), []);

  const m = await repo.metricas(B);
  assert.equal(m.totalConversaciones, 0);
  assert.equal(m.totalCitas, 0);
  assert.equal(m.ingresosEstimados, 0);
});

test("lectura: mismo cliente en 2 tenants — cada uno ve SOLO lo suyo", async () => {
  const repo = new RepositorioEnMemoria();
  const citaA = await sembrarTenant(repo, A, "lavado-basico");
  const citaB = await sembrarTenant(repo, B, "pulido");

  // Citas por cliente: A ve la de A, B ve la de B (ids y servicios distintos).
  const activasA = await repo.citasActivasCliente(A, CLIENTE, HOY);
  const activasB = await repo.citasActivasCliente(B, CLIENTE, HOY);
  assert.deepEqual(activasA.map((c) => c.id), [citaA.id]);
  assert.deepEqual(activasB.map((c) => c.id), [citaB.id]);
  assert.equal(activasA[0].servicioId, "lavado-basico");
  assert.equal(activasB[0].servicioId, "pulido");

  // Bandeja: cada tenant tiene exactamente 1 conversación, la suya.
  const bandejaA = await repo.listarConversaciones(A);
  const bandejaB = await repo.listarConversaciones(B);
  assert.equal(bandejaA.length, 1);
  assert.equal(bandejaB.length, 1);
  assert.equal(bandejaA[0].id, convId(A));
  assert.equal(bandejaB[0].id, convId(B));

  // Ficha: el nombre/historial no se mezcla pese al mismo número.
  const fichaA = await repo.fichaCliente(A, CLIENTE);
  const fichaB = await repo.fichaCliente(B, CLIENTE);
  assert.equal(fichaA?.nombre, `Cliente ${A}`);
  assert.equal(fichaB?.nombre, `Cliente ${B}`);
  assert.equal(fichaA?.totalCitas, 1);
  assert.equal(fichaB?.totalCitas, 1);

  // Push subs: una por tenant, sin cruce.
  assert.deepEqual((await repo.listarPushSubs(A)).map((s) => s.endpoint), [`https://push/${A}`]);
  assert.deepEqual((await repo.listarPushSubs(B)).map((s) => s.endpoint), [`https://push/${B}`]);

  // Métricas: cada tenant cuenta 1 conversación y 1 cita, no 2.
  assert.equal((await repo.metricas(A)).totalCitas, 1);
  assert.equal((await repo.metricas(B)).totalCitas, 1);
  assert.equal((await repo.metricas(A)).totalConversaciones, 1);
});

// ── Escrituras: mutar con el tenantId equivocado debe rechazar y NO tocar nada ──

// Mutaciones de CITA scopeadas por tenant: con el tenant ajeno devuelven null.
const MUTACIONES_CITA: Array<{ nombre: string; ejecutar: (r: Repositorio, t: string, id: string) => Promise<Cita | null> }> = [
  { nombre: "reprogramarCita", ejecutar: (r, t, id) => r.reprogramarCita(t, id, "2026-09-09", "15:00") },
  { nombre: "cancelarCita", ejecutar: (r, t, id) => r.cancelarCita(t, id) },
  { nombre: "confirmarCita", ejecutar: (r, t, id) => r.confirmarCita(t, id) },
  { nombre: "completarCita", ejecutar: (r, t, id) => r.completarCita(t, id) },
  { nombre: "marcarNoShow", ejecutar: (r, t, id) => r.marcarNoShow(t, id) },
];

for (const { nombre, ejecutar } of MUTACIONES_CITA) {
  test(`escritura: ${nombre} con tenant ajeno devuelve null y NO muta la cita`, async () => {
    const repo = new RepositorioEnMemoria();
    const cita = await sembrarTenant(repo, A, "lavado-basico");

    // B intenta mutar una cita de A → rechazo.
    assert.equal(await ejecutar(repo, B, cita.id), null);

    // La cita de A sigue intacta (agendada, fecha original, sin confirmar).
    const [aunAgendada] = await repo.citasActivasCliente(A, CLIENTE, HOY);
    assert.equal(aunAgendada.id, cita.id);
    assert.equal(aunAgendada.estado, "agendada");
    assert.equal(aunAgendada.fecha, FUTURO);
    assert.equal(aunAgendada.confirmadaEn, undefined);

    // El dueño legítimo SÍ puede (control positivo: no rechazamos por bug genérico).
    assert.notEqual(await ejecutar(repo, A, cita.id), null);
  });
}

// Mutaciones de CONVERSACIÓN scopeadas por tenant: con el tenant ajeno son no-op.
test("escritura: mutaciones de conversación con tenant ajeno son no-op", async () => {
  const repo = new RepositorioEnMemoria();
  await sembrarTenant(repo, A, "lavado-basico");
  const idA = convId(A);

  // B intenta manosear la conversación de A. Todas deben ser no-op silenciosas.
  await repo.setModoConversacion(B, idA, "humano");
  await repo.marcarEstadoConversacion(B, idA, "atendida");
  await repo.guardarNotas(B, idA, "nota inyectada por B");
  await repo.marcarLeidas(B, idA);

  // El estado de A no cambió: sigue en bot / abierta.
  assert.equal(await repo.obtenerModo(A, idA), "bot");
  const convA = await repo.obtenerConversacionPorId(A, idA);
  assert.equal(convA?.modo, "bot");
  assert.equal(convA?.estado, "abierta");

  // La nota inyectada por B no quedó en la ficha de A.
  const ficha = await repo.fichaCliente(A, CLIENTE);
  assert.equal(ficha?.notas, "");

  // Control positivo: A sí puede mutar su propia conversación.
  await repo.setModoConversacion(A, idA, "humano");
  assert.equal(await repo.obtenerModo(A, idA), "humano");
});

// Recordatorios NO reciben tenantId (se identifican por citaId único, que ya
// incluye el tenant en su generación). Se afirma que el claim de la cita de A no
// bloquea la de B: cada cita tiene su propio estado de recordatorio.
test("escritura: claim de recordatorio de una cita no afecta la del otro tenant", async () => {
  const repo = new RepositorioEnMemoria();
  const citaA = await sembrarTenant(repo, A, "lavado-basico");
  const citaB = await sembrarTenant(repo, B, "pulido");

  assert.equal(await repo.reclamarRecordatorio(citaA.id, "dia_antes"), true);
  // La cita de B nunca fue reclamada: su claim sigue disponible.
  assert.equal(await repo.reclamarRecordatorio(citaB.id, "dia_antes"), true);
  // Re-reclamar la de A falla (ya tomada), sin arrastrar a B.
  assert.equal(await repo.reclamarRecordatorio(citaA.id, "dia_antes"), false);
});

// Rescate de cotizaciones (Carril D, 1.1): mismo cliente cotizando en 2 tenants no
// debe cruzarse — ni al registrar (el guard "no dos rescates activos" es por tenant)
// ni al cerrar por cita (actualizarCotizacionPorCita no debe tocar la del otro).
test("escritura: registrarCotizacion/actualizarCotizacionPorCita no se cruzan entre tenants", async () => {
  const repo = new RepositorioEnMemoria();
  const cotizA = await repo.registrarCotizacion(A, CLIENTE, "pulido-a", 15000);
  const cotizB = await repo.registrarCotizacion(B, CLIENTE, "pulido-b", 20000);
  assert.ok(cotizA);
  assert.ok(cotizB);

  // El mismo cliente puede tener una cotización activa en CADA tenant a la vez
  // (el guard "no dos rescates activos" es scopeado por tenant, no global).
  assert.notEqual(cotizA, null);
  assert.notEqual(cotizB, null);

  // Cerrar la cotización de A (agenda con ese servicio) no debe tocar la de B.
  await repo.actualizarCotizacionPorCita(A, CLIENTE, "pulido-a", "cita-a", 15000);
  assert.equal(cotizA!.estado, "agendada");
  assert.equal(cotizB!.estado, "pendiente", "la cotización de B sigue intacta");
});

// Upsell (Carril D, 1.2): mismo cliente en 2 tenants no debe cruzar ni el rechazo de
// add-on (una preferencia por tenant, no global) ni el add-on agregado a una cita.
test("escritura: agregarAddonACita/registrarRechazoAddon/fueRechazadoAddonRecientemente no se cruzan entre tenants", async () => {
  const repo = new RepositorioEnMemoria();
  const citaA = await sembrarTenant(repo, A, "lavado-basico");
  await sembrarTenant(repo, B, "pulido");

  // Cliente rechaza el add-on en A: solo A queda bloqueado, B sigue libre de ofrecerlo.
  await repo.registrarRechazoAddon(A, CLIENTE, "addon-x");
  assert.equal(await repo.fueRechazadoAddonRecientemente(A, CLIENTE, "addon-x", HOY), true);
  assert.equal(await repo.fueRechazadoAddonRecientemente(B, CLIENTE, "addon-x", HOY), false);

  // agregarAddonACita con el tenant equivocado (B intentando tocar la cita de A) rechaza.
  assert.equal(await repo.agregarAddonACita(B, citaA.id, { servicioId: "addon-y", precio: 5000 }), null);
  const actualizada = await repo.agregarAddonACita(A, citaA.id, { servicioId: "addon-y", precio: 5000 });
  assert.deepEqual(actualizada?.addons, [{ servicioId: "addon-y", precio: 5000 }]);
});

// Motor de reseñas de Google completo (Carril D, Fase 1 - 1.3): los seguimientos
// post-servicio y los snapshots de reputación son por tenant — no deben cruzarse
// aunque el job/scheduler procese varios negocios en el mismo tick.
test("escritura: seguimientosDeTenant/historicoReputacion no se cruzan entre tenants", async () => {
  const repo = new RepositorioEnMemoria();
  const citaA = await sembrarTenant(repo, A, "lavado-basico");
  const citaB = await sembrarTenant(repo, B, "pulido");

  await repo.crearSeguimiento(A, citaA.id);
  await repo.crearSeguimiento(B, citaB.id);
  await repo.registrarRespuestaSeguimiento(citaA.id, "positivo", true, "Excelente 😃");
  await repo.registrarRespuestaSeguimiento(citaB.id, "negativo", false, "Mal 😞");

  const segA = await repo.seguimientosDeTenant(A);
  const segB = await repo.seguimientosDeTenant(B);
  assert.equal(segA.length, 1);
  assert.equal(segB.length, 1);
  assert.equal(segA[0].sentimiento, "positivo");
  assert.equal(segB[0].sentimiento, "negativo");

  await repo.guardarSnapshotReputacion(A, "2026-08-01", 4.5, 50);
  await repo.guardarSnapshotReputacion(B, "2026-08-01", 3.8, 12);
  assert.equal((await repo.historicoReputacion(A, 10))[0].rating, 4.5);
  assert.equal((await repo.historicoReputacion(B, 10))[0].rating, 3.8);

  // Métricas: la reputación de A no se filtra a las métricas de B.
  assert.equal((await repo.metricas(A)).reputacion?.rating, 4.5);
  assert.equal((await repo.metricas(B)).reputacion?.rating, 3.8);
});
