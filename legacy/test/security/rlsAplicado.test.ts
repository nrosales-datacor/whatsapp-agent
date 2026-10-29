import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// F1 de punta a punta: la base corre con el rol de la app (`app_wa`, SIN BYPASSRLS) y
// cada función de producción que toca Postgres se ejerce al menos una vez. Si alguna se
// olvida de `conTenant`/`conSistema` (src/db/alcance.ts), acá falla: no ve sus filas o
// la política rechaza la escritura. Y lo que un negocio escribe no lo ve otro.
//
// Toda la siembra pasa por código de producción (nada de INSERT crudos como superusuario).
// ─────────────────────────────────────────────────────────────────────────────

process.env.DATABASE_URL = "postgres://pglite-inyectada/test";
process.env.TOKENS_ENCRYPTION_KEY = "ab".repeat(32);
process.env.TENANTS_REFRESH_MS = "0";
process.env.PANEL_SESSION_SECRET = "test-rls-aplicado-session-secret-0123";
delete process.env.SUPABASE_URL;

const { crearDbEfimera } = await import("../helpers/pgliteDb");
const { _inyectarDbParaTests } = await import("../../src/db/client");
const { crearTenant } = await import("../helpers/fixtures");
const tenantStore = await import("../../src/config/tenantStore");
const { RepositorioDrizzle } = await import("../../src/booking/drizzleRepository");
const cola = await import("../../src/queue/cola");
const crudos = await import("../../src/db/webhooksCrudos");
const { intentarLiderazgo } = await import("../../src/red/liderazgo");
const uso = await import("../../src/observabilidad/uso");
const campanias = await import("../../src/campaigns/campanias");
const colaCampanias = await import("../../src/campaigns/cola");
const { almacenConsentimiento } = await import("../../src/campaigns/consentimiento");
const { previsualizarSegmentoDetalle, resumenConsentimiento } = await import("../../src/campaigns/segmentos");
const rescate = await import("../../src/rescate/cola");
const { evaluarVigilancia } = await import("../../src/observabilidad/vigilancia");
const auditoria = await import("../../src/config/auditoria");
const { borrarDatosCliente } = await import("../../src/config/supresionCliente");
const { darDeBajaTenant } = await import("../../src/config/offboarding");
const { aplicarFrenosPorCliente } = await import("../../src/red/limiteCliente");
const { chequearSalud } = await import("../../src/salud");
const { hashearPassword } = await import("../../src/panel/auth");

const base = await crearDbEfimera();
const { db } = base;
_inyectarDbParaTests(db);
after(() => base.cerrar());
const repo = new RepositorioDrizzle(db);

const A = crearTenant({ id: "negocio-a", nombre: "Negocio A", phoneNumberId: "pnid-a", accessToken: "token-a" });
const B = crearTenant({ id: "negocio-b", nombre: "Negocio B", phoneNumberId: "pnid-b", accessToken: "token-b" });
const TEL = "50688887777";
const FECHA = "2099-01-05";

before(async () => {
  // Desde acá, TODO corre como el rol de la app: sin BYPASSRLS.
  await base.client.exec("SET ROLE app_wa");
  await tenantStore.cargarTenants(); // base vacía → fallback; habilita las escrituras (hayDb)
  const hash = await hashearPassword("clave-segura-123");
  await tenantStore.crearTenant(A, { usuario: "dueno-a", passwordHash: hash });
  await tenantStore.crearTenant(B, { usuario: "dueno-b", passwordHash: hash });
  await tenantStore.cargarTenants();
});

test("RLS aplicado: el rol de la app no tiene BYPASSRLS y sin contexto no ve nada", async () => {
  const r = await base.client.query<{ actual: string; bypass: boolean }>(
    "SELECT current_user AS actual, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass",
  );
  assert.equal(r.rows[0].actual, "app_wa");
  assert.equal(r.rows[0].bypass, false);
  const sinContexto = await base.client.query<{ n: number }>("SELECT count(*)::int AS n FROM wa_tenants");
  assert.equal(sinContexto.rows[0].n, 0, "sin conTenant/conSistema no se ve ni una fila");
});

test("RLS aplicado: caché de tenants y usuarios (contexto de sistema)", async () => {
  assert.ok(tenantStore.obtenerTenantPorId("negocio-a"), "el caché carga los negocios");
  assert.equal(tenantStore.obtenerTenantPorId("negocio-a")?.accessToken, "token-a", "y descifra su token");
  assert.ok(tenantStore.obtenerUsuario("dueno-b"), "y los usuarios");
  const usuarios = await tenantStore.listarUsuariosDeTenant("negocio-a");
  assert.deepEqual(usuarios.map((u) => u.usuario), ["dueno-a"], "cada negocio ve solo su equipo");
  await tenantStore.crearUsuarioTenant("negocio-a", { usuario: "oper-a", passwordHash: "x:y", rol: "operador" });
  const oper = (await tenantStore.listarUsuariosDeTenant("negocio-a")).find((u) => u.usuario === "oper-a")!;
  await tenantStore.actualizarUsuarioTenant("negocio-a", oper.id, { rol: "dueno" });
  assert.ok(await tenantStore.resetearClaveUsuario(oper.id, "x:z", new Date(Date.now() + 3_600_000)));
  await tenantStore.cambiarClavePropia("negocio-a", oper.id, "x:w");
  await tenantStore.actualizarTopeTenant("negocio-a", true);
  await tenantStore.actualizarFacturacionTenant("negocio-a", { stripeCustomerId: "cus_a" });
  assert.equal(await tenantStore.buscarTenantIdPorStripeCustomer("cus_a"), "negocio-a");
  assert.equal(await tenantStore.cambiarEstadoTenant("negocio-b", false, "superadmin:test", "prueba"), "ok");
  assert.equal(await tenantStore.cambiarEstadoTenant("negocio-b", true, "superadmin:test", null), "ok");
  assert.ok(await tenantStore.actualizarConexionWhatsapp("negocio-b", "pnid-b", "token-b2", "superadmin:test"));
  await tenantStore.recargar();
  assert.equal(tenantStore.obtenerTenantPorId("negocio-a")?.topeConversacionesDesactivado, true);
});

test("RLS aplicado: config versionada del negocio", async () => {
  const t = tenantStore.obtenerTenantPorId("negocio-a")!;
  await tenantStore.actualizarConfigTenant(
    "negocio-a",
    {
      horario: t.horario,
      servicios: t.servicios,
      kb: t.kb,
      bloqueos: [],
      empleados: [],
      linkResenas: null,
      plantillaMarketing: "promo",
      plantillaReapertura: null,
      plantillaRecordatorio: null,
      plantillaIdioma: null,
      colorAcento: null,
      colorHeader: null,
      logoUrl: null,
      rescateActivo: true,
      rescateHorasEspera: 3,
      rescateToque1Texto: null,
      rescateToque2Texto: null,
      rescatePlantilla: null,
      googlePlaceId: null,
      googleCalendarId: null,
      tipoNegocio: null,
      pais: null,
      formasPago: null,
      registro: null,
      tono: null,
      instrucciones: null,
      mensajeTopeExcedido: null,
    },
    "usuario-x",
  );
  const historial = await tenantStore.listarHistorialConfigTenant("negocio-a");
  assert.equal(historial.length, 1);
  assert.equal(await tenantStore.restaurarVersionConfigTenant("negocio-a", historial[0].id, "usuario-x"), true);
  assert.equal(await tenantStore.restaurarVersionConfigTenant("negocio-b", historial[0].id, "usuario-x"), false, "B no ve versiones de A");
  await tenantStore.recargar();
});

test("RLS aplicado: repositorio completo dentro de un negocio, invisible para el otro", async () => {
  const conv = await repo.obtenerOConversacion(A.id, TEL);
  assert.equal(await repo.guardarMensaje(A.id, conv.id, { rol: "user", contenido: "hola", creadoEn: new Date().toISOString(), waMessageId: "wamid.1" }), true);
  assert.equal(await repo.guardarMensaje(B.id, conv.id, { rol: "user", contenido: "intruso", creadoEn: new Date().toISOString() }), false);
  await repo.actualizarMediaMensaje(A.id, conv.id, "wamid.1", "negocio-a/x.jpg", "imagen");
  await repo.marcarOptIn(A.id, conv.id);
  await repo.marcarOptOut(A.id, conv.id);
  await repo.setModoConversacion(A.id, conv.id, "humano");
  await repo.marcarEstadoConversacion(A.id, conv.id, "atendida");
  await repo.marcarLeidas(A.id, conv.id);
  await repo.guardarNotas(A.id, conv.id, "notas privadas");
  await repo.registrarCalidad({ tenantId: A.id, clienteWa: TEL, tipo: "mensaje_ok" });
  assert.equal(await repo.obtenerModo(A.id, conv.id), "humano");
  assert.equal(await repo.obtenerModo(B.id, conv.id), null, "B no ve la conversación de A");
  assert.equal((await repo.mensajesRecientes(A.id, conv.id, 10)).length, 1);
  assert.equal((await repo.mensajesRecientes(B.id, conv.id, 10)).length, 0);
  assert.ok(await repo.obtenerConversacionPorId(A.id, conv.id));
  assert.equal(await repo.obtenerConversacionPorId(B.id, conv.id), null);
  assert.equal((await repo.listarConversaciones(A.id)).length, 1);
  assert.equal((await repo.listarConversaciones(B.id)).length, 0);

  const cita = await repo.crearCita(
    { tenantId: A.id, clienteWa: TEL, clienteNombre: "Ana", servicioId: "lavado", fecha: FECHA, hora: "09:00", precio: 8000 },
    () => true,
  );
  await repo.guardarGcalEventId(A.id, cita.id, "evt-1");
  assert.equal((await repo.citasPorFecha(A.id, FECHA)).length, 1);
  assert.equal((await repo.citasPorFecha(B.id, FECHA)).length, 0);
  assert.equal((await repo.citasEnRango(A.id, FECHA, FECHA)).length, 1);
  assert.equal((await repo.citasActivasCliente(A.id, TEL, FECHA)).length, 1);
  assert.ok(await repo.obtenerCitaPorId(A.id, cita.id));
  assert.equal(await repo.obtenerCitaPorId(B.id, cita.id), null);
  assert.equal(await repo.cancelarCita(B.id, cita.id), null, "B no puede cancelar una cita de A");
  assert.ok(await repo.reprogramarCita(A.id, cita.id, FECHA, "10:00", () => true));
  assert.ok(await repo.reasignarCita(A.id, cita.id, null));
  assert.ok(await repo.confirmarCita(A.id, cita.id));
  assert.ok(await repo.agregarAddonACita(A.id, cita.id, { servicioId: "encerado", precio: 5000 }));
  await repo.marcarRecordatorio(A.id, cita.id, "dia_antes");
  await repo.revertirRecordatorio(A.id, cita.id, "dia_antes");
  assert.equal(await repo.reclamarRecordatorio(A.id, cita.id, "dia_antes"), true);
  await repo.crearSeguimiento(A.id, cita.id);
  await repo.registrarRespuestaSeguimiento(A.id, cita.id, "positivo", true, "Excelente");
  assert.equal((await repo.seguimientosDeTenant(A.id)).length, 1);
  assert.equal((await repo.seguimientosDeTenant(B.id)).length, 0);
  assert.ok(await repo.registrarCotizacion(A.id, "50611110000", "lavado", 8000));
  await repo.actualizarCotizacionPorCita(A.id, "50611110000", "lavado", cita.id, 8000);
  await repo.registrarRechazoAddon(A.id, TEL, "encerado");
  assert.equal(await repo.fueRechazadoAddonRecientemente(A.id, TEL, "encerado", new Date().toISOString().slice(0, 10)), true);
  await repo.guardarSnapshotReputacion(A.id, FECHA, 4.8, 120);
  assert.equal((await repo.historicoReputacion(A.id, 5)).length, 1);
  assert.equal((await repo.historicoReputacion(B.id, 5)).length, 0);
  const m = await repo.metricas(A.id);
  assert.equal(m.totalConversaciones, 1);
  assert.equal((await repo.metricas(B.id)).totalConversaciones, 0);
  const ficha = await repo.fichaCliente(A.id, TEL);
  assert.equal(ficha?.notas, "notas privadas");
  assert.equal(await repo.fichaCliente(B.id, TEL), null);
  assert.ok(await repo.completarCita(A.id, (await repo.crearCita({ tenantId: A.id, clienteWa: TEL, clienteNombre: "Ana", servicioId: "lavado", fecha: FECHA, hora: "11:00" })).id));
  assert.ok(await repo.marcarNoShow(A.id, (await repo.crearCita({ tenantId: A.id, clienteWa: TEL, clienteNombre: "Ana", servicioId: "lavado", fecha: FECHA, hora: "12:00" })).id));

  const usuarioA = tenantStore.obtenerUsuario("dueno-a")!;
  await repo.guardarPushSub(A.id, { endpoint: "https://push/1", p256dh: "p", auth: "a", usuarioId: usuarioA.id, sessionEpoch: 0 }, { maxPorUsuario: 3 });
  assert.equal((await repo.listarPushSubs(A.id)).length, 1);
  assert.equal((await repo.listarPushSubs(B.id)).length, 0);
  // El mismo navegador pasa a otro negocio: el dispositivo es de quien está logueado ahora.
  await repo.guardarPushSub(B.id, { endpoint: "https://push/1", p256dh: "p", auth: "a" });
  assert.equal((await repo.listarPushSubs(A.id)).length, 0);
  assert.equal((await repo.listarPushSubs(B.id)).length, 1);
  await repo.borrarPushSub(B.id, "https://push/1");
  await repo.borrarPushSubsDeUsuario(A.id, usuarioA.id);
});

test("RLS aplicado: cola de mensajes, crudos y liderazgo (contexto de sistema)", async () => {
  const conv = await repo.obtenerOConversacion(B.id, TEL);
  const encolado = await repo.guardarEntranteYEncolar(
    conv.id,
    { rol: "user", contenido: "hola B", creadoEn: new Date().toISOString(), waMessageId: "wamid.b.1" },
    {
      clase: "texto",
      tenantId: B.id,
      entrante: { phoneNumberId: "pnid-b", clienteWa: TEL, esTexto: true, texto: "hola B", messageId: "wamid.b.1" },
      conv: { ...conv, mensajes: [] },
      agrupable: true,
      releeHistorial: true,
    },
  );
  assert.equal(encolado, true);
  const job = await cola.reclamarUno(db);
  assert.ok(job, "el worker reclama jobs de cualquier negocio");
  await cola.marcarFalloOReintentar(db, job!.id, "falla", 5, 5, B.id);
  assert.equal((await cola.listarJobsEnError(db)).length, 1);
  assert.equal(await cola.reencolarJobError(db, job!.id), true);
  const otra = await cola.reclamarUno(db);
  await cola.marcarHecho(db, otra!.id);
  assert.equal(await cola.reencolarVencidos(db, 0), 0);
  await cola.purgarJobsHechos(db, 0);

  await crudos.guardarCrudo(db, { payload: { x: 1 }, phoneNumberId: "pnid-nuevo", waMessageId: "wamid.crudo", motivo: "tenant_desconocido" });
  const pendientes = await crudos.listarPendientes(db);
  assert.equal(pendientes.length, 1);
  await crudos.marcarIntentoFallido(db, pendientes[0].id, 0, 5);
  await crudos.marcarProcesado(db, pendientes[0].id);
  await crudos.purgarWebhooksCrudos(db, 0);

  assert.equal(await intentarLiderazgo(db, "prueba", "proceso-1", 60_000), true);
  assert.equal(await intentarLiderazgo(db, "prueba", "proceso-2", 60_000), false);

  const salud = await chequearSalud(db);
  assert.notEqual(salud.cola.pendientes, null, "el health check cuenta la cola");
  const vig = await evaluarVigilancia(db, { tenants: [tenantStore.obtenerTenantPorId("negocio-a")!] });
  assert.notEqual(vig.colaAtascada, null, "los detectores de vigilancia leen la cola");
});

test("RLS aplicado: uso mensual, campañas, consentimiento, rescate y frenos", async () => {
  const anioMes = new Date().toISOString().slice(0, 7);
  await uso.incrementarUso(db, A.id, anioMes, { mensajesEntrantes: 2 });
  assert.equal((await uso.obtenerUsoMensualDb(db, A.id, anioMes))?.mensajesEntrantes, 2);
  assert.equal(await uso.obtenerUsoMensualDb(db, B.id, anioMes), null);
  assert.ok((await uso.listarUsoMensualActual()).has(A.id), "el admin ve el uso de todos");

  const almacen = almacenConsentimiento(db);
  await almacen.marcarPedido(A.id, TEL);
  await almacen.otorgar(A.id, TEL);
  assert.ok((await almacen.leer(A.id, TEL)).consentimientoEn);
  assert.equal((await almacen.leer(B.id, TEL)).consentimientoEn, null);
  assert.equal((await resumenConsentimiento(A.id)).conConsentimiento, 1);
  assert.equal((await previsualizarSegmentoDetalle(A.id, { tipo: "todos" })).destinatarios.length, 1);

  const camp = await campanias.crearCampania(A.id, { nombre: "Promo", mensaje: "10% off", segmentoTipo: "todos", segmentoParametros: { tipo: "todos" } });
  assert.equal((await campanias.listarCampanias(A.id)).length, 1);
  assert.equal((await campanias.listarCampanias(B.id)).length, 0);
  await campanias.confirmarEnvioCampania(A.id, camp.id, null);
  const envio = await colaCampanias.reclamarEnvio(db);
  assert.ok(envio, "el worker de campañas reclama envíos de cualquier negocio");
  await colaCampanias.marcarEnviado(db, envio!.id);
  assert.equal(await colaCampanias.quedanPendientes(db, camp.id), false);
  assert.ok(await campanias.obtenerCampania(A.id, camp.id));
  assert.equal(await campanias.obtenerCampania(B.id, camp.id), null);

  const cand = await rescate.reclamarToque1(db, A.id, new Date(Date.now() + 3_600_000));
  if (cand) await rescate.revertirToque1(db, cand.id);
  await rescate.siguioOptOut(db, A.id, TEL);
  await rescate.enModoHumano(db, A.id, TEL);
  await rescate.nombreClienteAprox(db, A.id, TEL);
  assert.ok((await rescate.citasDelDia(db, A.id, FECHA)).length > 0);
  await rescate.purgarCotizacionesFinalizadas(db, 0);

  const conv = await repo.obtenerOConversacion(A.id, TEL);
  const frenado = await aplicarFrenosPorCliente({ tenant: tenantStore.obtenerTenantPorId("negocio-a")!, repo, conv, clienteWa: TEL, db });
  assert.equal(frenado, false);
});

test("RLS aplicado: auditoría, supresión de un cliente y baja de un negocio", async () => {
  await auditoria.registrarAuditoria(db, A.id, "pausar", "superadmin:test", { motivo: "prueba" });
  assert.ok((await auditoria.listarAuditoriaTenant(db, A.id)).length > 0);
  assert.equal((await auditoria.listarAuditoriaTenant(db, "otro")).length, 0);
  assert.ok((await auditoria.ultimaPausaPorTenant(db, [A.id, B.id])).has(A.id));

  const conv = await repo.obtenerOConversacion(B.id, "50699990000");
  await repo.guardarMensaje(B.id, conv.id, { rol: "user", contenido: "borrame", creadoEn: new Date().toISOString() });
  const r = await borrarDatosCliente({ tenant: tenantStore.obtenerTenantPorId("negocio-b")!, conversacionId: conv.id, actor: "superadmin:test", db });
  assert.ok(r.conteos.mensajes >= 1);

  const exportado = await darDeBajaTenant(B.id, "Negocio B", db);
  assert.equal(exportado.waTenants.id, B.id);
  await tenantStore.recargar();
  assert.equal(tenantStore.obtenerTenantPorId("negocio-b"), undefined);
  assert.ok(tenantStore.obtenerTenantPorId("negocio-a"), "la baja de B no toca a A");
});
