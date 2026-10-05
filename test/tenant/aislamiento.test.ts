import assert from "node:assert/strict";
import { test } from "node:test";
import { RepositorioDrizzle } from "../../src/booking/drizzleRepository";
import { crearDbEfimera } from "../helpers/pgliteDb";
import type { Cita, PushSub, Repositorio } from "../../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// Ángulo 2 de TESTING.md — INVARIANTE MULTI-TENANT (seguridad, no cosmético).
//
// F4: esta batería corre IDÉNTICA contra las DOS implementaciones del
// Repositorio — RepositorioDrizzle
// sobre Postgres efímero (PGlite: el SQL real de producción) — porque antes
// solo se probaba la de memoria (`test/tenant/aislamiento.test.ts:3` original),
// y esa NO es la que corre en producción. Un test en verde contra el repo
// equivocado no garantiza nada del sistema real.
//
// Con 2 tenants sembrados (y el MISMO número de cliente en ambos, la prueba más
// dura de la clave `tenantId:clienteWa`), ninguna operación del tenant A debe
// ver ni escribir datos del B. Una fuga acá es un INCIDENTE, no un bug
// cosmético. Por eso se recorre CADA método del Repositorio scopeado por
// tenant con el tenantId equivocado y se espera vacío / null / no-op, con su
// control positivo (el dueño legítimo SÍ puede).
//
// Alcance: cubre conversaciones, citas, ficha, métricas, push subs,
// recordatorios, cotizaciones (rescate), add-ons (upsell) y el motor de
// reseñas. Usuarios / config / campañas viven fuera de este repo (auth y
// stores propios) y se cubren en el panel E2E (ángulo 6, guards de rol 403).
// ─────────────────────────────────────────────────────────────────────────────

const A = "tenant-A";
const B = "tenant-B";
// MISMO número de cliente en ambos tenants: la prueba más dura de la clave
// `tenantId:clienteWa`. Dos negocios pueden atender al mismo teléfono sin cruzarse.
const CLIENTE = "50611112222";
const HOY = "2026-07-14";
const FUTURO = "2026-08-01";

/** Una implementación del Repositorio a ejercer con la misma batería de casos. */
interface Implementacion {
  nombre: string;
  /** Crea una instancia fresca (Drizzle: su propia base efímera) y el cleanup correspondiente. */
  crear: () => Promise<{ repo: Repositorio; cerrar: () => Promise<void> }>;
}

const IMPLEMENTACIONES: Implementacion[] = [
  {
    nombre: "RepositorioDrizzle (PGlite)",
    crear: async () => {
      const { db, cerrar } = await crearDbEfimera();
      return { repo: new RepositorioDrizzle(db), cerrar };
    },
  },
];

/**
 * Siembra una conversación + un mensaje + una cita futura + una push sub por
 * tenant. Devuelve los ids REALES que asignó el repo (UUIDs generados por la base).
 */
async function sembrarTenant(
  repo: Repositorio,
  tenantId: string,
  servicioId: string,
): Promise<{ cita: Cita; convId: string }> {
  const conv = await repo.obtenerOConversacion(tenantId, CLIENTE);
  await repo.guardarMensaje(tenantId, conv.id, {
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
  return { cita, convId: conv.id };
}

// Mutaciones de CITA scopeadas por tenant: con el tenant ajeno devuelven null.
const MUTACIONES_CITA: Array<{ nombre: string; ejecutar: (r: Repositorio, t: string, id: string) => Promise<Cita | null> }> = [
  { nombre: "reprogramarCita", ejecutar: (r, t, id) => r.reprogramarCita(t, id, "2026-09-09", "15:00") },
  { nombre: "cancelarCita", ejecutar: (r, t, id) => r.cancelarCita(t, id) },
  { nombre: "confirmarCita", ejecutar: (r, t, id) => r.confirmarCita(t, id) },
  { nombre: "completarCita", ejecutar: (r, t, id) => r.completarCita(t, id) },
  { nombre: "marcarNoShow", ejecutar: (r, t, id) => r.marcarNoShow(t, id) },
];

for (const impl of IMPLEMENTACIONES) {
  // ── Lecturas: sembrar SOLO A y consultar como B debe dar vacío/null ──

  test(`[${impl.nombre}] lectura: un tenant sin datos no ve NADA del otro (todas las lecturas scopeadas)`, async () => {
    const { repo, cerrar } = await impl.crear();
    try {
      const { convId: convA } = await sembrarTenant(repo, A, "lavado-basico");
      // B jamás fue sembrado: toda lectura suya debe venir vacía.

      assert.deepEqual(await repo.citasPorFecha(B, FUTURO), []);
      assert.deepEqual(await repo.citasEnRango(B, HOY, "2026-12-31"), []);
      assert.deepEqual(await repo.citasActivasCliente(B, CLIENTE, HOY), []);
      assert.deepEqual(await repo.listarConversaciones(B), []);
      assert.equal(await repo.obtenerConversacionPorId(B, convA), null);
      assert.equal(await repo.obtenerModo(B, convA), null);
      assert.equal(await repo.fichaCliente(B, CLIENTE), null);
      assert.deepEqual(await repo.listarPushSubs(B), []);

      const m = await repo.metricas(B);
      assert.equal(m.totalConversaciones, 0);
      assert.equal(m.totalCitas, 0);
      assert.equal(m.ingresosEstimados, 0);
    } finally {
      await cerrar();
    }
  });

  test(`[${impl.nombre}] lectura: mismo cliente en 2 tenants — cada uno ve SOLO lo suyo`, async () => {
    const { repo, cerrar } = await impl.crear();
    try {
      const { cita: citaA, convId: convA } = await sembrarTenant(repo, A, "lavado-basico");
      const { cita: citaB, convId: convB } = await sembrarTenant(repo, B, "pulido");

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
      assert.equal(bandejaA[0].id, convA);
      assert.equal(bandejaB[0].id, convB);

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
    } finally {
      await cerrar();
    }
  });

  // ── Escrituras: mutar con el tenantId equivocado debe rechazar y NO tocar nada ──

  for (const { nombre, ejecutar } of MUTACIONES_CITA) {
    test(`[${impl.nombre}] escritura: ${nombre} con tenant ajeno devuelve null y NO muta la cita`, async () => {
      const { repo, cerrar } = await impl.crear();
      try {
        const { cita } = await sembrarTenant(repo, A, "lavado-basico");

        // B intenta mutar una cita de A → rechazo.
        assert.equal(await ejecutar(repo, B, cita.id), null);

        // La cita de A sigue intacta (agendada, fecha original, sin confirmar).
        const [aunAgendada] = await repo.citasActivasCliente(A, CLIENTE, HOY);
        assert.equal(aunAgendada.id, cita.id);
        assert.equal(aunAgendada.estado, "agendada");
        assert.equal(aunAgendada.fecha, FUTURO);
        assert.equal(aunAgendada.confirmadaEn, null);

        // El dueño legítimo SÍ puede (control positivo: no rechazamos por bug genérico).
        assert.notEqual(await ejecutar(repo, A, cita.id), null);
      } finally {
        await cerrar();
      }
    });
  }

  // Mutaciones de CONVERSACIÓN scopeadas por tenant: con el tenant ajeno son no-op.
  test(`[${impl.nombre}] escritura: mutaciones de conversación con tenant ajeno son no-op`, async () => {
    const { repo, cerrar } = await impl.crear();
    try {
      const { convId: idA } = await sembrarTenant(repo, A, "lavado-basico");

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
    } finally {
      await cerrar();
    }
  });

  // Recordatorios (F4: ahora reciben tenantId como defensa en profundidad, aunque
  // citaId ya sea único). Se afirma que el claim de la cita de A no bloquea la de B:
  // cada cita tiene su propio estado de recordatorio.
  test(`[${impl.nombre}] escritura: claim de recordatorio de una cita no afecta la del otro tenant`, async () => {
    const { repo, cerrar } = await impl.crear();
    try {
      const { cita: citaA } = await sembrarTenant(repo, A, "lavado-basico");
      const { cita: citaB } = await sembrarTenant(repo, B, "pulido");

      assert.equal(await repo.reclamarRecordatorio(A, citaA.id, "dia_antes"), true);
      // La cita de B nunca fue reclamada: su claim sigue disponible.
      assert.equal(await repo.reclamarRecordatorio(B, citaB.id, "dia_antes"), true);
      // Re-reclamar la de A falla (ya tomada), sin arrastrar a B.
      assert.equal(await repo.reclamarRecordatorio(A, citaA.id, "dia_antes"), false);
    } finally {
      await cerrar();
    }
  });

  // Rescate de cotizaciones (Carril D, 1.1): mismo cliente cotizando en 2 tenants no
  // debe cruzarse — ni al registrar (el guard "no dos rescates activos" es por tenant)
  // ni al cerrar por cita (actualizarCotizacionPorCita no debe tocar la del otro).
  test(`[${impl.nombre}] escritura: registrarCotizacion/actualizarCotizacionPorCita no se cruzan entre tenants`, async () => {
    const { repo, cerrar } = await impl.crear();
    try {
      const cotizA = await repo.registrarCotizacion(A, CLIENTE, "pulido-a", 15000);
      const cotizB = await repo.registrarCotizacion(B, CLIENTE, "pulido-b", 20000);
      assert.ok(cotizA);
      assert.ok(cotizB);

      // El mismo cliente puede tener una cotización activa en CADA tenant a la vez
      // (el guard "no dos rescates activos" es scopeado por tenant, no global).
      assert.notEqual(cotizA, null);
      assert.notEqual(cotizB, null);

      // Cerrar la cotización de A (agenda con ese servicio) no debe tocar la de B.
      // La interfaz no expone un "obtenerCotizacion", así que afirmamos por el efecto
      // observable disponible: registrar una SEGUNDA cotización para el MISMO servicio
      // solo se permite si la anterior ya no está activa (el guard "no dos rescates
      // activos" lee el estado real de la base).
      await repo.actualizarCotizacionPorCita(A, CLIENTE, "pulido-a", "cita-a", 15000);
      const segundaA = await repo.registrarCotizacion(A, CLIENTE, "pulido-a", 15000);
      assert.notEqual(segundaA, null, "la cotización de A ya se cerró (agendada), se puede abrir una nueva");
      // La de B sigue activa: un segundo intento para el MISMO servicio de B debe
      // rechazarse (todavía "pendiente").
      const segundaB = await repo.registrarCotizacion(B, CLIENTE, "pulido-b", 20000);
      assert.equal(segundaB, null, "la cotización de B sigue intacta (pendiente), no se abre una segunda");
    } finally {
      await cerrar();
    }
  });

  // Upsell (Carril D, 1.2): mismo cliente en 2 tenants no debe cruzar ni el rechazo de
  // add-on (una preferencia por tenant, no global) ni el add-on agregado a una cita.
  // agregarAddonACita (F4): el SELECT ya filtraba por tenant; el UPDATE también debe.
  test(`[${impl.nombre}] escritura: agregarAddonACita/registrarRechazoAddon/fueRechazadoAddonRecientemente no se cruzan entre tenants`, async () => {
    const { repo, cerrar } = await impl.crear();
    try {
      const { cita: citaA } = await sembrarTenant(repo, A, "lavado-basico");
      await sembrarTenant(repo, B, "pulido");

      // Cliente rechaza el add-on en A: solo A queda bloqueado, B sigue libre de ofrecerlo.
      await repo.registrarRechazoAddon(A, CLIENTE, "addon-x");
      assert.equal(await repo.fueRechazadoAddonRecientemente(A, CLIENTE, "addon-x", HOY), true);
      assert.equal(await repo.fueRechazadoAddonRecientemente(B, CLIENTE, "addon-x", HOY), false);

      // agregarAddonACita con el tenant equivocado (B intentando tocar la cita de A) rechaza.
      assert.equal(await repo.agregarAddonACita(B, citaA.id, { servicioId: "addon-y", precio: 5000 }), null);
      const actualizada = await repo.agregarAddonACita(A, citaA.id, { servicioId: "addon-y", precio: 5000 });
      assert.deepEqual(actualizada?.addons, [{ servicioId: "addon-y", precio: 5000 }]);
    } finally {
      await cerrar();
    }
  });

  // Motor de reseñas de Google completo (Carril D, Fase 1 - 1.3): los seguimientos
  // post-servicio y los snapshots de reputación son por tenant — no deben cruzarse
  // aunque el job/scheduler procese varios negocios en el mismo tick.
  test(`[${impl.nombre}] escritura: seguimientosDeTenant/historicoReputacion no se cruzan entre tenants`, async () => {
    const { repo, cerrar } = await impl.crear();
    try {
      const { cita: citaA } = await sembrarTenant(repo, A, "lavado-basico");
      const { cita: citaB } = await sembrarTenant(repo, B, "pulido");

      await repo.crearSeguimiento(A, citaA.id);
      await repo.crearSeguimiento(B, citaB.id);
      await repo.registrarRespuestaSeguimiento(A, citaA.id, "positivo", true, "Excelente 😃");
      await repo.registrarRespuestaSeguimiento(B, citaB.id, "negativo", false, "Mal 😞");

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
    } finally {
      await cerrar();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // F4, Parte A — casos para las 9 escrituras que antes NO recibían tenantId.
  // Ninguna es explotable hoy (el id siempre llega de una lectura ya scopeada),
  // pero se prueban igual: son P0 el día que uno de esos ids llegue de una
  // fuente no validada.
  // ─────────────────────────────────────────────────────────────────────────

  test(`[${impl.nombre}] F4: borrarPushSub con tenant ajeno no borra; el dueño sí`, async () => {
    const { repo, cerrar } = await impl.crear();
    try {
      await sembrarTenant(repo, A, "lavado-basico");
      const endpoint = `https://push/${A}`;

      await repo.borrarPushSub(B, endpoint); // tenant ajeno: no-op
      assert.deepEqual((await repo.listarPushSubs(A)).map((s) => s.endpoint), [endpoint]);

      await repo.borrarPushSub(A, endpoint); // dueño legítimo: sí borra
      assert.deepEqual(await repo.listarPushSubs(A), []);
    } finally {
      await cerrar();
    }
  });

  test(`[${impl.nombre}] F4: guardarMensaje/marcarOptIn/marcarOptOut/actualizarMediaMensaje con tenant ajeno son no-op`, async () => {
    const { repo, cerrar } = await impl.crear();
    try {
      const { convId: convA } = await sembrarTenant(repo, A, "lavado-basico");

      // guardarMensaje: tenant ajeno devuelve false y NO cuelga el mensaje de la conversación de A.
      const guardadoAjeno = await repo.guardarMensaje(B, convA, {
        rol: "user",
        contenido: "inyectado por B",
        creadoEn: `${HOY}T11:00:00.000Z`,
      });
      assert.equal(guardadoAjeno, false);
      let conv = await repo.obtenerConversacionPorId(A, convA);
      assert.ok(!conv!.mensajes.some((m) => m.contenido === "inyectado por B"));

      // Control positivo: el dueño sí guarda.
      const guardadoDueno = await repo.guardarMensaje(A, convA, {
        rol: "user",
        contenido: "mensaje legítimo",
        creadoEn: `${HOY}T11:05:00.000Z`,
      });
      assert.equal(guardadoDueno, true);

      // marcarOptIn: tenant ajeno no marca el opt-in de A.
      await repo.marcarOptIn(B, convA);
      conv = await repo.obtenerConversacionPorId(A, convA);
      assert.equal(conv?.optInEn, null);
      await repo.marcarOptIn(A, convA);
      conv = await repo.obtenerConversacionPorId(A, convA);
      assert.ok(conv?.optInEn);

      // marcarOptOut: tenant ajeno no marca la baja de campañas de A.
      await repo.marcarOptOut(B, convA);
      conv = await repo.obtenerConversacionPorId(A, convA);
      assert.equal(conv?.optOutEn, null);
      await repo.marcarOptOut(A, convA);
      conv = await repo.obtenerConversacionPorId(A, convA);
      assert.ok(conv?.optOutEn);

      // actualizarMediaMensaje: tenant ajeno no adjunta la foto a un mensaje de A.
      const conFoto = await repo.guardarMensaje(A, convA, {
        rol: "user",
        contenido: "[foto]",
        creadoEn: `${HOY}T11:10:00.000Z`,
        waMessageId: "wamid-foto-1",
      });
      assert.equal(conFoto, true);
      await repo.actualizarMediaMensaje(B, convA, "wamid-foto-1", "data:image/png;base64,xxx", "imagen");
      conv = await repo.obtenerConversacionPorId(A, convA);
      assert.equal(conv!.mensajes.find((m) => m.waMessageId === "wamid-foto-1")?.mediaUrl, undefined);
      await repo.actualizarMediaMensaje(A, convA, "wamid-foto-1", "data:image/png;base64,xxx", "imagen");
      conv = await repo.obtenerConversacionPorId(A, convA);
      assert.equal(
        conv!.mensajes.find((m) => m.waMessageId === "wamid-foto-1")?.mediaUrl,
        "data:image/png;base64,xxx",
      );
    } finally {
      await cerrar();
    }
  });

  test(`[${impl.nombre}] F4: guardarGcalEventId con tenant ajeno no toca la cita; el dueño sí`, async () => {
    const { repo, cerrar } = await impl.crear();
    try {
      const { cita } = await sembrarTenant(repo, A, "lavado-basico");

      await repo.guardarGcalEventId(B, cita.id, "evt-ajeno");
      let [intacta] = await repo.citasActivasCliente(A, CLIENTE, HOY);
      assert.equal(intacta.gcalEventId, undefined);

      await repo.guardarGcalEventId(A, cita.id, "evt-legitimo");
      [intacta] = await repo.citasActivasCliente(A, CLIENTE, HOY);
      assert.equal(intacta.gcalEventId, "evt-legitimo");
    } finally {
      await cerrar();
    }
  });

  test(`[${impl.nombre}] F4: marcarRecordatorio con tenant ajeno no marca; el dueño sí`, async () => {
    const { repo, cerrar } = await impl.crear();
    try {
      const { cita } = await sembrarTenant(repo, A, "lavado-basico");

      await repo.marcarRecordatorio(B, cita.id, "dia_antes");
      let [intacta] = await repo.citasActivasCliente(A, CLIENTE, HOY);
      assert.equal(intacta.recordatorioDiaAntesEn, null);

      await repo.marcarRecordatorio(A, cita.id, "dia_antes");
      [intacta] = await repo.citasActivasCliente(A, CLIENTE, HOY);
      assert.ok(intacta.recordatorioDiaAntesEn);
    } finally {
      await cerrar();
    }
  });

  test(`[${impl.nombre}] F4: reclamarRecordatorio/revertirRecordatorio con tenant ajeno no interfieren con el dueño`, async () => {
    const { repo, cerrar } = await impl.crear();
    try {
      const { cita } = await sembrarTenant(repo, A, "lavado-basico");

      // B intenta reclamar la cita de A: no gana el claim.
      assert.equal(await repo.reclamarRecordatorio(B, cita.id, "mismo_dia"), false);
      // El dueño SÍ puede reclamarla después (el intento de B no "gastó" el claim).
      assert.equal(await repo.reclamarRecordatorio(A, cita.id, "mismo_dia"), true);
      // Reclamo repetido del dueño ahora sí falla (ya está tomado).
      assert.equal(await repo.reclamarRecordatorio(A, cita.id, "mismo_dia"), false);

      // B intenta revertir el claim de A: no-op.
      await repo.revertirRecordatorio(B, cita.id, "mismo_dia");
      assert.equal(
        await repo.reclamarRecordatorio(A, cita.id, "mismo_dia"),
        false,
        "el revert de B no debió liberar el claim de A",
      );

      // El dueño SÍ puede revertir su propio claim y reclamarlo de nuevo.
      await repo.revertirRecordatorio(A, cita.id, "mismo_dia");
      assert.equal(await repo.reclamarRecordatorio(A, cita.id, "mismo_dia"), true);
    } finally {
      await cerrar();
    }
  });

  test(`[${impl.nombre}] F4: registrarRespuestaSeguimiento con tenant ajeno no modifica el seguimiento; el dueño sí`, async () => {
    const { repo, cerrar } = await impl.crear();
    try {
      const { cita } = await sembrarTenant(repo, A, "lavado-basico");
      await repo.crearSeguimiento(A, cita.id);

      await repo.registrarRespuestaSeguimiento(B, cita.id, "positivo", true, "inyectado por B");
      let [seg] = await repo.seguimientosDeTenant(A);
      assert.equal(seg.sentimiento, null);

      await repo.registrarRespuestaSeguimiento(A, cita.id, "positivo", true, "Excelente 😃");
      [seg] = await repo.seguimientosDeTenant(A);
      assert.equal(seg.sentimiento, "positivo");
    } finally {
      await cerrar();
    }
  });
}
