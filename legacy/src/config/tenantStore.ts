import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type {
  Bloqueo,
  Empleado,
  EstadoFacturacion,
  HorarioDia,
  KnowledgeBase,
  Plan,
  Rol,
  Service,
  Tenant,
  TextosCliente,
} from "../types";
import { hayBaseDeDatos as hayBaseDeDatosConfigurada, obtenerDb } from "../db/client";
import { conSistema, conTenant, type Tx } from "../db/alcance";
import { schema, waPushSubs, waTenants, waUsuarios } from "../db/schema";
import { cifrar, descifrar } from "./secretos";
import { TENANT_FALLBACK_SELYON } from "./tenants";
import { normalizarKb } from "./validadores";
import { registrarAuditoria } from "./auditoria";
import {
  listarHistorialTenant,
  obtenerVersionHistorial,
  registrarVersionConfig,
  type VersionConfigTenant,
} from "./tenantsHistorial";

type DB = PostgresJsDatabase<typeof schema>;

// ─────────────────────────────────────────────────────────────────────────────
// Fuente ÚNICA de tenants para todo el código (ROADMAP B2). La base
// (wa_tenants / wa_usuarios) es la fuente de verdad; acá se mantiene un CACHÉ EN
// MEMORIA con accesores SÍNCRONOS para el hot path (webhook, auth del panel) — así
// no hay un viaje al DB por cada mensaje entrante.
//
// Sin DATABASE_URL (dev), o si la base no tiene tenants / no responde, se cae a un
// FALLBACK hardcodeado (rosales) para que el bot NUNCA quede sin tenants (outage).
// El caché se recarga al arrancar, periódicamente, y on-demand ante un número nuevo.
// ─────────────────────────────────────────────────────────────────────────────

export interface CuentaUsuario {
  id: string;
  tenantId: string;
  passwordHash: string;
  /** Rol dentro del negocio (C2.3): "dueno" edita "Mi negocio" y gestiona usuarios. */
  rol: Rol;
  /** Reset de contraseña desde el admin (Carril D, 0.5): fuerza el cambio al loguearse. */
  debeCambiarClave: boolean;
  /** Vencimiento de la clave temporal (0.5). Null = clave normal. */
  claveTemporalExpira: Date | null;
  /** true si la cuenta está activa. Ver también activo en waUsuarios; solo las cuentas
   * activas entran al caché de login (recargarDesdeDb filtra por activo=true), pero
   * sesionDeOperador necesita distinguir "no existe" de "existe pero inactiva" para las
   * cuentas registradas vía _registrarUsuarioParaTests. En producción, una cuenta
   * desactivada simplemente desaparece del caché en la próxima recarga. */
  activo: boolean;
  /** Epoch de sesión (E13/ALTO-06): sube en cada cambio de clave/rol/estado de la cuenta.
   * `sesionDeOperador` compara esto contra el epoch firmado en el token — si no coinciden,
   * la sesión es de ANTES del cambio y se trata como inválida (igual que un token vencido). */
  sessionEpoch: number;
}

interface Cache {
  porPnid: Map<string, Tenant>;
  porId: Map<string, Tenant>;
  usuarios: Map<string, CuentaUsuario>;
  // Negocios PAUSADOS (wa_tenants.activo = false, revisión pre-venta 2026-10): viven en
  // índices APARTE a propósito. Todo el código que ya existe (webhook, worker, schedulers,
  // panel) consulta `porId`/`porPnid` y por lo tanto sigue sin "ver" a un pausado — el bot
  // no le responde, no salen recordatorios ni campañas, y el login no entra. Solo los
  // puntos que necesitan distinguir "pausado" de "no existe" consultan estos índices: el
  // webhook (para guardar el mensaje sin responder, en vez de mandarlo a wa_webhooks_crudos
  // a que se descarte), el panel (aviso de "cuenta pausada" en vez de un 401 genérico) y el
  // admin (para listarlo y poder reactivarlo).
  pausadosPorPnid: Map<string, Tenant>;
  pausadosPorId: Map<string, Tenant>;
}

// Caché vivo. Se reemplaza ENTERO de forma atómica en cada recarga (nunca se muta
// in-place, para no servir un caché a medio llenar).
let cache: Cache = construirCache([], []);
let hayDb = false;

// Fuente del caché VIGENTE (ROADMAP E10, health check): se actualiza junto con `cache`
// en los mismos tres puntos donde hoy se reasigna (cacheFallback en activarFallback,
// cacheFallback en cargarTenants sin DB, y construirCache en recargarDesdeDb exitoso).
// No toca la lógica de recarga/fallback existente: solo deja constancia de CUÁL de los
// dos caminos se tomó, para que /salud pueda distinguir "caché real" de "caché de
// emergencia" sin adivinar a partir de otro estado.
let fuenteActual: "db" | "fallback" = "fallback";

function construirCache(
  tenants: Tenant[],
  usuarios: {
    id: string;
    usuario: string;
    tenantId: string;
    passwordHash: string;
    rol: Rol;
    debeCambiarClave: boolean;
    claveTemporalExpira: Date | null;
    sessionEpoch: number;
  }[],
  pausados: Tenant[] = [],
): Cache {
  const porPnid = new Map<string, Tenant>();
  const porId = new Map<string, Tenant>();
  for (const t of tenants) {
    porId.set(t.id, t);
    porPnid.set(t.phoneNumberId, t);
  }
  const pausadosPorPnid = new Map<string, Tenant>();
  const pausadosPorId = new Map<string, Tenant>();
  for (const t of pausados) {
    pausadosPorId.set(t.id, t);
    pausadosPorPnid.set(t.phoneNumberId, t);
  }
  const us = new Map<string, CuentaUsuario>();
  for (const u of usuarios) {
    us.set(u.usuario, {
      id: u.id,
      tenantId: u.tenantId,
      passwordHash: u.passwordHash,
      rol: u.rol,
      debeCambiarClave: u.debeCambiarClave,
      claveTemporalExpira: u.claveTemporalExpira,
      // Todo lo que llega hasta acá viene de recargarDesdeDb, que ya filtra por
      // activo=true (o de cacheFallback/_registrarUsuarioParaTests, siempre activos por
      // construcción) — una cuenta desactivada simplemente desaparece del caché.
      activo: true,
      sessionEpoch: u.sessionEpoch,
    });
  }
  return { porPnid, porId, usuarios: us, pausadosPorPnid, pausadosPorId };
}

// Caché de emergencia: el tenant hardcodeado + un usuario sintético desde el hash
// de .env. Mantiene el bot atendiendo a Selyon si la base aún no está sembrada.
// Es el único login del negocio → dueño.
function cacheFallback(): Cache {
  const t = TENANT_FALLBACK_SELYON;
  const usuarios = [];
  const hash = process.env.PANEL_PASSWORD_HASH_SELYON;
  if (hash) {
    usuarios.push({
      id: "fallback",
      usuario: t.id,
      tenantId: t.id,
      passwordHash: hash,
      rol: "dueno" as Rol,
      debeCambiarClave: false,
      claveTemporalExpira: null,
      sessionEpoch: 0,
    });
  }
  return construirCache([t], usuarios);
}

function filaATenant(f: typeof waTenants.$inferSelect): Tenant {
  return {
    id: f.id,
    nombre: f.nombre,
    phoneNumberId: f.phoneNumberId,
    // Descifrado ÚNICO punto de entrada al construir el caché (ROADMAP F2): a partir de
    // acá, todo el código (incluido whatsapp/client.ts) sigue viendo el token en claro,
    // sin enterarse de que en la base está cifrado. `descifrar` tolera valores heredados
    // en texto plano (ver comentario en secretos.ts) — no hace falta migrar antes de desplegar.
    accessToken: f.accessToken ? descifrar(f.accessToken) : undefined,
    timezone: f.timezone,
    moneda: f.moneda,
    ubicacion: f.ubicacion,
    intervaloAgendaMin: f.intervaloAgendaMin,
    horario: f.horario,
    servicios: f.servicios,
    // normalizarKb migra al vuelo los kb viejos (tarifas/parabrisas → secciones): sin
    // esto, un tenant guardado antes de las "secciones libres" perdería esos datos del
    // prompt (systemPrompt ya no lee tarifas/parabrisas). Ver [[deploy-migracion-obligatoria]].
    kb: normalizarKb(f.kb),
    bloqueos: f.bloqueos,
    // `?? []` y no solo `f.empleados`: una fila escrita antes de la columna puede venir
    // sin el campo, y ahí el negocio debe seguir corriendo en modo recurso único.
    empleados: f.empleados ?? [],
    linkResenas: f.linkResenas ?? undefined,
    plantillaMarketing: f.plantillaMarketing ?? undefined,
    plantillaReapertura: f.plantillaReapertura ?? undefined,
    plantillaRecordatorio: f.plantillaRecordatorio ?? undefined,
    plantillaIdioma: f.plantillaIdioma ?? undefined,
    colorAcento: f.colorAcento ?? undefined,
    colorHeader: f.colorHeader ?? undefined,
    logoUrl: f.logoUrl ?? undefined,
    plan: (f.plan as Plan | undefined) ?? "pro",
    stripeCustomerId: f.stripeCustomerId ?? undefined,
    stripeSubscriptionId: f.stripeSubscriptionId ?? undefined,
    estadoFacturacion: (f.estadoFacturacion as EstadoFacturacion | null) ?? undefined,
    facturacionPeriodoFin: f.facturacionPeriodoFin?.toISOString() ?? undefined,
    rescateActivo: f.rescateActivo,
    rescateHorasEspera: f.rescateHorasEspera,
    rescateToque1Texto: f.rescateToque1Texto ?? undefined,
    rescateToque2Texto: f.rescateToque2Texto ?? undefined,
    rescatePlantilla: f.rescatePlantilla ?? undefined,
    googlePlaceId: f.googlePlaceId ?? undefined,
    googleCalendarId: f.googleCalendarId ?? undefined,
    tipoNegocio: f.tipoNegocio ?? undefined,
    pais: f.pais ?? undefined,
    formasPago: f.formasPago ?? undefined,
    registro: (f.registro as Tenant["registro"]) ?? undefined,
    tono: f.tono ?? undefined,
    instrucciones: f.instrucciones ?? undefined,
    topeConversacionesDesactivado: f.topeConversacionesDesactivado,
    mensajeTopeExcedido: f.mensajeTopeExcedido ?? undefined,
    textosCliente: f.textosCliente ?? undefined,
  };
}

// ── Callbacks tras una recarga exitosa (ROADMAP F3) ──
// Este módulo NO conoce handleWebhook ni el reproceso de wa_webhooks_crudos: solo
// expone un registro de callbacks GENÉRICO. Es server.ts quien, al arrancar,
// conecta acá el reproceso real (ver el comentario largo en reprocesoWebhooks.ts
// sobre por qué esto evita un ciclo de imports). Cualquier otro módulo futuro que
// necesite reaccionar a "el caché de tenants cambió" puede colgarse del mismo hook.
type CallbackRecarga = () => void;
const callbacksRecarga: CallbackRecarga[] = [];

/** Registra un callback que se dispara después de cada recarga EXITOSA del caché
 * (trae al menos un tenant real, no el fallback). Pensado para el reproceso de
 * F3: un negocio recién dado de alta puede recuperar acá los mensajes que
 * llegaron antes de existir. */
export function alRecargar(cb: CallbackRecarga): void {
  callbacksRecarga.push(cb);
}

function notificarRecarga(): void {
  for (const cb of callbacksRecarga) {
    try {
      cb();
    } catch (e) {
      console.error("[tenantStore] un callback de alRecargar lanzó:", e);
    }
  }
}

async function recargarDesdeDb(): Promise<void> {
  try {
    // Sistema: el caché es el registro de TODOS los negocios (ruteo del webhook, login).
    // Se leen TODOS los tenants (no solo activo = true) para poder separar los pausados en
    // sus propios índices (ver `Cache`). Si TODOS están pausados se arma igual un caché sin
    // activos, NO el fallback: el fallback hardcodeado podría ser justamente un negocio que
    // se pausó por falta de pago, y volvería a atender gratis.
    const { filas, usuarios } = await conSistema(obtenerDb(), async (tx) => ({
      filas: await tx.select().from(waTenants),
      usuarios: await tx.select().from(waUsuarios).where(eq(waUsuarios.activo, true)),
    }));
    const tenants = filas.filter((f) => f.activo);
    const pausados = filas.filter((f) => !f.activo);
    if (filas.length === 0) {
      activarFallback("la base no tiene tenants");
      return;
    }
    cache = construirCache(
      tenants.map(filaATenant),
      usuarios.map((u) => ({
        id: u.id,
        usuario: u.usuario,
        tenantId: u.tenantId,
        passwordHash: u.passwordHash,
        rol: u.rol as Rol,
        debeCambiarClave: u.debeCambiarClave,
        claveTemporalExpira: u.claveTemporalExpira,
        sessionEpoch: u.sessionEpoch,
      })),
      pausados.map(filaATenant),
    );
    fuenteActual = "db";
    notificarRecarga();
  } catch (e) {
    activarFallback(`no se pudo leer la base (${e instanceof Error ? e.message : String(e)})`);
  }
}

// Cae al fallback SOLO si todavía no hay nada cargado (arranque con base vacía /
// inalcanzable). Si ya hay un caché válido (p. ej. un refresh que falló), se
// conserva — nunca tiramos tenants buenos por un blip de red.
function activarFallback(motivo: string): void {
  if (cache.porId.size > 0 || cache.pausadosPorId.size > 0) {
    console.error(`[tenantStore] ⚠️ ${motivo}; conservo el caché actual (${cache.porId.size} tenant/s).`);
    return;
  }
  cache = cacheFallback();
  fuenteActual = "fallback";
  console.error(
    `[tenantStore] ⚠️ ${motivo} — usando fallback hardcodeado 'selyon'. ` +
      "EL ALTA DE NEGOCIOS NO ESTÁ DISPONIBLE hasta sembrar la base (npx tsx scripts/seedTenants.ts).",
  );
}

const REFRESH_MS = Number(process.env.TENANTS_REFRESH_MS ?? 60_000);
let refrescoIniciado = false;
function iniciarRefresco(): void {
  if (refrescoIniciado || REFRESH_MS <= 0) return;
  refrescoIniciado = true;
  const t = setInterval(() => void recargarDesdeDb(), REFRESH_MS);
  t.unref?.(); // no mantener vivo el proceso solo por este timer
}

/** Carga inicial del caché. Llamar UNA vez antes de aceptar tráfico (server.listen). */
export async function cargarTenants(): Promise<void> {
  hayDb = hayBaseDeDatosConfigurada();
  if (!hayDb) {
    cache = cacheFallback();
    fuenteActual = "fallback";
    console.log(`[tenantStore] sin base de datos: ${cache.porId.size} tenant(s) en memoria (fallback).`);
    return;
  }
  await recargarDesdeDb();
  iniciarRefresco();
}

// ── Accesores síncronos (hot path: leen el caché, nunca el DB) ──

export function obtenerTenantPorPhoneNumberId(pnid: string): Tenant | undefined {
  return cache.porPnid.get(pnid);
}

export function obtenerTenantPorId(id: string): Tenant | undefined {
  return cache.porId.get(id);
}

export function listarTenants(): Tenant[] {
  return [...cache.porId.values()];
}

// ── Negocios pausados (revisión pre-venta 2026-10) ──
// Ver el comentario de `Cache.pausadosPorPnid`: estos accesores existen SOLO para los
// puntos que tienen que distinguir "pausado" de "no existe". El resto del código usa los
// de arriba y, por construcción, nunca ve a un negocio pausado.

export function obtenerTenantPausadoPorPhoneNumberId(pnid: string): Tenant | undefined {
  return cache.pausadosPorPnid.get(pnid);
}

export function obtenerTenantPausadoPorId(id: string): Tenant | undefined {
  return cache.pausadosPorId.get(id);
}

export function listarTenantsPausados(): Tenant[] {
  return [...cache.pausadosPorId.values()];
}

/** Cuenta de panel para el login (resuelve usuario → tenant + hash). */
export function obtenerUsuario(usuario: string): CuentaUsuario | undefined {
  return cache.usuarios.get(usuario);
}

// Cuentas por negocio: pocas decenas por tenant en el caso de uso real (panel de un
// lavacar), así que un scan lineal por request de /me es más simple que mantener un
// segundo índice por id solo para esto.
/** Cuenta de panel por id (para /me y el cambio de clave — la sesión solo trae el id). */
export function obtenerUsuarioPorId(usuarioId: string): CuentaUsuario | undefined {
  for (const c of cache.usuarios.values()) if (c.id === usuarioId) return c;
  return undefined;
}

// ── Escritura: alta de negocios (onboarding, ROADMAP B3) ──

/** true si hay base configurada (el alta de negocios la requiere). */
export function hayBaseDeDatos(): boolean {
  return hayBaseDeDatosConfigurada();
}

/**
 * Fuente del caché de tenants VIGENTE ahora mismo (ROADMAP E10, health check):
 * "db" tras una recarga exitosa contra la base; "fallback" si se está sirviendo el
 * tenant hardcodeado (sin DATABASE_URL, o porque la base no respondió/estaba vacía
 * en el último intento de recarga). Ojo: NO es lo mismo que `hayBaseDeDatos()` —
 * esa dice si HAY una DATABASE_URL configurada; esta dice de dónde viene el caché
 * que el bot está usando en este momento. La combinación de ambas es justo el
 * escenario silencioso de BLOQUEANTE-11: DB configurada + caché en fallback = el
 * bot está atendiendo con la config equivocada mientras el resto luce normal.
 */
export function fuenteCacheTenants(): "db" | "fallback" {
  return fuenteActual;
}

/** Recarga inmediata del caché desde la base (tras un alta). No-op sin DATABASE_URL. */
export async function recargar(): Promise<void> {
  if (!hayDb) return;
  await recargarDesdeDb();
}

interface NuevoUsuario {
  usuario: string;
  passwordHash: string;
}

/**
 * Da de alta un negocio y su primer usuario de panel en UNA transacción (o ambos o
 * ninguno). Lanza Error("SIN_DB") si no hay base. Deja propagar el error de Postgres
 * con code "23505" (choque de índice único: id, phone_number_id o usuario repetido)
 * para que el router lo mapee a un 409 con mensaje claro.
 */
export async function crearTenant(tenant: Tenant, u: NuevoUsuario): Promise<void> {
  if (!hayDb) throw new Error("SIN_DB");
  // Acotado al negocio NUEVO: las filas que se insertan son todas de `tenant.id`.
  await conTenant(obtenerDb(), tenant.id, async (tx) => {
    await tx.insert(waTenants).values({
      id: tenant.id,
      nombre: tenant.nombre,
      phoneNumberId: tenant.phoneNumberId,
      // Cifrado ÚNICO punto de escritura del token (ROADMAP F2): nunca se persiste en
      // claro. `null` se guarda tal cual (nada que cifrar) — ver nota en secretos.ts.
      accessToken: tenant.accessToken ? cifrar(tenant.accessToken) : null,
      timezone: tenant.timezone,
      moneda: tenant.moneda,
      ubicacion: tenant.ubicacion,
      intervaloAgendaMin: tenant.intervaloAgendaMin,
      horario: tenant.horario,
      servicios: tenant.servicios,
      kb: tenant.kb,
      bloqueos: tenant.bloqueos,
      empleados: tenant.empleados ?? [],
      // Perfil del negocio (B7): el formulario de alta lo pide y validarAltaTenant lo
      // arma; sin estas columnas el negocio arrancaba con el prompt genérico y el dueño
      // tenía que volver a cargarlo en "Mi negocio".
      tipoNegocio: tenant.tipoNegocio ?? null,
      pais: tenant.pais ?? null,
      formasPago: tenant.formasPago ?? null,
      registro: tenant.registro ?? null,
      tono: tenant.tono ?? null,
      instrucciones: tenant.instrucciones ?? null,
      linkResenas: tenant.linkResenas ?? null,
      plantillaMarketing: tenant.plantillaMarketing ?? null,
      plantillaReapertura: tenant.plantillaReapertura ?? null,
      plantillaRecordatorio: tenant.plantillaRecordatorio ?? null,
      plantillaIdioma: tenant.plantillaIdioma ?? null,
      colorAcento: tenant.colorAcento ?? null,
      colorHeader: tenant.colorHeader ?? null,
      logoUrl: tenant.logoUrl ?? null,
      plan: tenant.plan,
      stripeCustomerId: tenant.stripeCustomerId ?? null,
      stripeSubscriptionId: tenant.stripeSubscriptionId ?? null,
      estadoFacturacion: tenant.estadoFacturacion ?? null,
      facturacionPeriodoFin: tenant.facturacionPeriodoFin ? new Date(tenant.facturacionPeriodoFin) : null,
      rescateActivo: tenant.rescateActivo ?? false,
      rescateHorasEspera: tenant.rescateHorasEspera ?? 3,
      rescateToque1Texto: tenant.rescateToque1Texto ?? null,
      rescateToque2Texto: tenant.rescateToque2Texto ?? null,
      rescatePlantilla: tenant.rescatePlantilla ?? null,
      googlePlaceId: tenant.googlePlaceId ?? null,
      googleCalendarId: tenant.googleCalendarId ?? null,
      topeConversacionesDesactivado: tenant.topeConversacionesDesactivado ?? false,
      mensajeTopeExcedido: tenant.mensajeTopeExcedido ?? null,
      textosCliente: tenant.textosCliente ?? null,
    });
    // El usuario del alta es, por definición, el dueño del negocio recién creado.
    await tx.insert(waUsuarios).values({ usuario: u.usuario, passwordHash: u.passwordHash, tenantId: tenant.id, rol: "dueno" });
  });
}

/** Forma exacta del blob que edita "Mi negocio" (ROADMAP C2.2) y que ahora también
 * queda versionado (ROADMAP F15): es el mismo objeto que `actualizarConfigTenant`
 * escribe en `wa_tenants` Y el que se guarda tal cual en `wa_tenants_historial.snapshot`,
 * así que restaurar una versión vieja es simplemente volver a llamar a
 * `actualizarConfigTenant` con el snapshot leído del historial. */
export interface ConfigTenantPatch {
  horario: Record<number, HorarioDia>;
  servicios: Service[];
  kb: KnowledgeBase;
  bloqueos: Bloqueo[];
  empleados: Empleado[];
  linkResenas: string | null;
  plantillaMarketing: string | null;
  plantillaReapertura: string | null;
  plantillaRecordatorio: string | null;
  plantillaIdioma: string | null;
  colorAcento: string | null;
  colorHeader: string | null;
  logoUrl: string | null;
  rescateActivo: boolean;
  rescateHorasEspera: number;
  rescateToque1Texto: string | null;
  rescateToque2Texto: string | null;
  rescatePlantilla: string | null;
  googlePlaceId: string | null;
  googleCalendarId: string | null;
  tipoNegocio: string | null;
  pais: string | null;
  formasPago: string | null;
  registro: string | null;
  tono: string | null;
  instrucciones: string | null;
  mensajeTopeExcedido: string | null;
  /**
   * Override de textos al cliente final (E11). OPCIONAL a propósito: `undefined` = no
   * se toca la columna. Así los snapshots de historial anteriores a E11 (que no lo
   * traen) se restauran sin borrar los overrides vigentes, y el /config del panel
   * sigue funcionando igual mientras no exponga este campo.
   */
  textosCliente?: TextosCliente | null;
}

/**
 * Actualiza la config self-service de un negocio (ROADMAP C2.2): horario, servicios, kb y
 * bloqueos, como un reemplazo completo (mismo patrón "blob JSONB entero" que crearTenant).
 * El caller debe llamar recargar() después para que el cambio quede visible sin esperar el
 * refresco periódico. Lanza Error("SIN_DB") si no hay base.
 *
 * ROADMAP F15: el `UPDATE` y el `INSERT` de la versión en `wa_tenants_historial` corren
 * en UNA sola transacción — o quedan los dos, o no queda ninguno. `usuarioId` es quién
 * hizo el cambio (el router ya lo saca de la sesión, ver `sesionDeOperador`). `db` es
 * opcional y SOLO para tests (inyectar la conexión efímera de PGlite): en producción
 * siempre se omite y se usa el pool singleton (`obtenerDb()`).
 */
export async function actualizarConfigTenant(
  tenantId: string,
  patch: ConfigTenantPatch,
  usuarioId: string,
  db?: DB,
): Promise<void> {
  if (!db && !hayDb) throw new Error("SIN_DB");
  await conTenant(db ?? obtenerDb(), tenantId, async (tx) => {
    await tx
      .update(waTenants)
      .set({
        horario: patch.horario,
        servicios: patch.servicios,
        kb: patch.kb,
        bloqueos: patch.bloqueos,
        empleados: patch.empleados,
        linkResenas: patch.linkResenas,
        plantillaMarketing: patch.plantillaMarketing,
        plantillaReapertura: patch.plantillaReapertura,
        plantillaRecordatorio: patch.plantillaRecordatorio,
        plantillaIdioma: patch.plantillaIdioma,
        colorAcento: patch.colorAcento,
        colorHeader: patch.colorHeader,
        logoUrl: patch.logoUrl,
        rescateActivo: patch.rescateActivo,
        rescateHorasEspera: patch.rescateHorasEspera,
        rescateToque1Texto: patch.rescateToque1Texto,
        rescateToque2Texto: patch.rescateToque2Texto,
        rescatePlantilla: patch.rescatePlantilla,
        googlePlaceId: patch.googlePlaceId,
        googleCalendarId: patch.googleCalendarId,
        tipoNegocio: patch.tipoNegocio,
        pais: patch.pais,
        formasPago: patch.formasPago,
        registro: patch.registro,
        tono: patch.tono,
        instrucciones: patch.instrucciones,
        mensajeTopeExcedido: patch.mensajeTopeExcedido,
        ...(patch.textosCliente !== undefined && { textosCliente: patch.textosCliente }),
        actualizadoEn: new Date(),
      })
      .where(eq(waTenants.id, tenantId));
    await registrarVersionConfig(tx, tenantId, patch, usuarioId);
  });
}

/**
 * Historial de versiones de "Mi negocio" para un tenant (ROADMAP F15), MÁS RECIENTE
 * PRIMERO. Self-service del dueño (el router gatea con rol === "dueno", mismo check que
 * "config"). `db` opcional solo para tests. Lanza Error("SIN_DB") si no hay base.
 */
export async function listarHistorialConfigTenant(
  tenantId: string,
  limite?: number,
  db?: DB,
): Promise<VersionConfigTenant[]> {
  if (!db && !hayDb) throw new Error("SIN_DB");
  return listarHistorialTenant(db ?? obtenerDb(), tenantId, limite);
}

/**
 * Restaura una versión vieja del historial (ROADMAP F15): un "restaurar" es un cambio
 * NUEVO, no un rollback destructivo — aplica el snapshot de esa versión vía el mismo
 * camino transaccional de `actualizarConfigTenant`, que a su vez crea una versión NUEVA
 * (idéntica a la vieja) sin tocar el historial existente, mismo criterio que un revert en
 * git. `usuarioId` es quién pidió la restauración. Devuelve false si `historialId` no
 * existe o pertenece a otro tenant (el caller SIEMPRE pasa el tenant de la sesión, nunca
 * uno arbitrario del body). `db` opcional solo para tests.
 */
export async function restaurarVersionConfigTenant(
  tenantId: string,
  historialId: string,
  usuarioId: string,
  db?: DB,
): Promise<boolean> {
  if (!db && !hayDb) throw new Error("SIN_DB");
  const d = db ?? obtenerDb();
  const version = await obtenerVersionHistorial(d, tenantId, historialId);
  if (!version) return false;
  await actualizarConfigTenant(tenantId, version.snapshot as ConfigTenantPatch, usuarioId, d);
  return true;
}

/**
 * Interruptor del tope mensual de conversaciones (F10 — PLAN-ESCALA-MULTITENANT.md):
 * lo cambia el superadmin, NO es self-service del dueño (a diferencia del resto de
 * `actualizarConfigTenant`) — es una excepción de contrato, mismo criterio que el
 * cambio de plan (`admin/tenants/:id/plan`). El caller debe llamar `recargar()`
 * después, mismo patrón que el resto de las escrituras de este módulo.
 */
export async function actualizarTopeTenant(tenantId: string, desactivado: boolean): Promise<void> {
  if (!hayDb) throw new Error("SIN_DB");
  await conTenant(obtenerDb(), tenantId, (tx) =>
    tx
      .update(waTenants)
      .set({ topeConversacionesDesactivado: desactivado, actualizadoEn: new Date() })
      .where(eq(waTenants.id, tenantId)),
  );
}

// ── Pausar / reactivar un negocio (revisión pre-venta 2026-10, cobro manual) ──

/**
 * Pausa (`activo: false`) o reactiva (`activo: true`) un negocio, y deja el rastro en
 * `wa_auditoria` en la MISMA transacción (o cambia el estado y queda registrado, o no
 * pasa ninguna de las dos). Es la palanca del día 10 de PROCESO-COBRO-MANUAL.md, que
 * antes era un `UPDATE` a mano en Supabase sin registro de quién ni por qué.
 *
 * NO borra ni toca ningún dato del negocio: pausado, el bot deja de responder (el
 * mensaje entrante igual se guarda, ver `ingerirEntrante`), no salen recordatorios,
 * campañas ni rescates, y el panel muestra "cuenta pausada". Reactivar lo devuelve
 * todo tal cual estaba.
 *
 * Devuelve `"no_encontrado"` si el id no existe y `"sin_cambio"` si ya estaba en ese
 * estado (no se registra nada: una pausa doble no es una pausa nueva). El caller debe
 * llamar `recargar()` después, mismo patrón que el resto de las escrituras. `db` es
 * opcional y SOLO para tests.
 */
export async function cambiarEstadoTenant(
  tenantId: string,
  activo: boolean,
  actor: string,
  motivo: string | null,
  db?: DB,
): Promise<"ok" | "sin_cambio" | "no_encontrado"> {
  if (!db && !hayDb) throw new Error("SIN_DB");
  return conTenant(db ?? obtenerDb(), tenantId, async (tx) => {
    const [fila] = await tx.select({ activo: waTenants.activo }).from(waTenants).where(eq(waTenants.id, tenantId));
    if (!fila) return "no_encontrado" as const;
    if (fila.activo === activo) return "sin_cambio" as const;
    await tx.update(waTenants).set({ activo, actualizadoEn: new Date() }).where(eq(waTenants.id, tenantId));
    await registrarAuditoria(tx, tenantId, activo ? "reactivar" : "pausar", actor, motivo ? { motivo } : {});
    return "ok" as const;
  });
}

/**
 * Carga o rota la conexión de WhatsApp de un negocio YA creado (revisión pre-venta
 * 2026-10): antes, un negocio dado de alta sin token (o con un token vencido/revocado)
 * no tenía arreglo — el token está cifrado (F2), así que tampoco se podía corregir con
 * SQL a mano. Cifra igual que `crearTenant` (único punto de escritura del token junto con
 * él) y audita en la misma transacción, SIN el token (solo el phone_number_id y si cambió).
 *
 * Deja propagar el 23505 de Postgres si el phone_number_id ya lo usa otro negocio (el
 * router lo mapea a 409). Devuelve false si el tenant no existe. El caller debe llamar
 * `recargar()` después. `db` opcional, SOLO para tests.
 */
export async function actualizarConexionWhatsapp(
  tenantId: string,
  phoneNumberId: string,
  accessToken: string,
  actor: string,
  db?: DB,
): Promise<boolean> {
  if (!db && !hayDb) throw new Error("SIN_DB");
  return conTenant(db ?? obtenerDb(), tenantId, async (tx) => {
    const [fila] = await tx.select({ pnid: waTenants.phoneNumberId }).from(waTenants).where(eq(waTenants.id, tenantId));
    if (!fila) return false;
    await tx
      .update(waTenants)
      .set({ phoneNumberId, accessToken: cifrar(accessToken), actualizadoEn: new Date() })
      .where(eq(waTenants.id, tenantId));
    await registrarAuditoria(tx, tenantId, "reconectar_whatsapp", actor, {
      phoneNumberId,
      cambioNumero: fila.pnid !== phoneNumberId,
    });
    return true;
  });
}

// ── Usuarios del panel por tenant (ROADMAP C2.3, "Mi negocio" → pestaña Usuarios) ──
// A diferencia del caché (que solo indexa usuarios ACTIVOS por username, para el login),
// estas lecturas/escrituras van directo a la base: son de baja frecuencia (las abre el
// dueño desde una pestaña de administración, no el hot path del webhook).

export interface UsuarioTenant {
  id: string;
  usuario: string;
  rol: Rol;
  activo: boolean;
  creadoEn: string; // ISO
  /** true si tiene una clave temporal pendiente de cambiar (reset del admin, 0.5). */
  debeCambiarClave: boolean;
}

/** Todos los usuarios (activos e inactivos) de un negocio, para la pestaña "Usuarios". */
export async function listarUsuariosDeTenant(tenantId: string): Promise<UsuarioTenant[]> {
  const filas = await conTenant(obtenerDb(), tenantId, (tx) =>
    tx.select().from(waUsuarios).where(eq(waUsuarios.tenantId, tenantId)),
  );
  return filas.map((f) => ({
    id: f.id,
    usuario: f.usuario,
    rol: f.rol as Rol,
    activo: f.activo,
    creadoEn: f.creadoEn.toISOString(),
    debeCambiarClave: f.debeCambiarClave,
  }));
}

interface NuevoUsuarioTenant {
  usuario: string;
  passwordHash: string;
  rol: Rol;
}

/**
 * Da de alta un usuario adicional del panel para un negocio ya existente (dueño
 * gestionando su equipo, C2.3). Lanza Error("SIN_DB") si no hay base. Deja propagar
 * el error de Postgres "23505" (usuario duplicado) para que el router lo mapee a 409.
 */
export async function crearUsuarioTenant(tenantId: string, u: NuevoUsuarioTenant): Promise<void> {
  if (!hayDb) throw new Error("SIN_DB");
  await conTenant(obtenerDb(), tenantId, (tx) =>
    tx.insert(waUsuarios).values({ usuario: u.usuario, passwordHash: u.passwordHash, tenantId, rol: u.rol }),
  );
}

/**
 * Actualiza rol y/o estado activo de un usuario del panel. Scopeada por tenantId en el
 * WHERE (defensa en profundidad: un dueño no puede tocar usuarios de otro negocio aunque
 * conozca el id). El guard de "al menos un dueño activo" lo valida el router ANTES de
 * llamar acá (necesita leer el resto del equipo para decidir). Lanza Error("SIN_DB") si
 * no hay base.
 *
 * Revocación de sesiones (E13/ALTO-06): cambiar el rol o desactivar la cuenta sube
 * `sessionEpoch` (atómico, `x = x + 1`, mismo patrón que `incrementarUso`) — cualquier
 * token firmado ANTES de este cambio deja de calzar con el epoch vigente y
 * `sesionDeOperador` lo trata como inválido en la próxima request, sin esperar a que
 * expire. Reactivar (activo: true) NO sube el epoch: no hay ninguna sesión vieja que
 * revocar (la cuenta desactivada ya no tenía epoch vigente que nadie pudiera usar).
 */
export async function actualizarUsuarioTenant(
  tenantId: string,
  usuarioId: string,
  patch: { rol?: Rol; activo?: boolean },
): Promise<void> {
  if (!hayDb) throw new Error("SIN_DB");
  const subeEpoch = patch.rol !== undefined || patch.activo === false;
  await conTenant(obtenerDb(), tenantId, async (tx) => {
    await tx
      .update(waUsuarios)
      .set({ ...patch, ...(subeEpoch ? { sessionEpoch: sql`${waUsuarios.sessionEpoch} + 1` } : {}) })
      .where(and(eq(waUsuarios.id, usuarioId), eq(waUsuarios.tenantId, tenantId)));
    // Mismo criterio para sus notificaciones push: un empleado desactivado (o con el rol
    // cambiado) deja de recibir avisos de clientes en su teléfono YA, no "cuando expire".
    if (subeEpoch) await borrarPushSubsDeUsuario(tx, usuarioId, tenantId);
  });
}

/**
 * Revocación de dispositivos push (revisión de seguridad 2026-10): cada vez que sube el
 * `sessionEpoch` de una cuenta (desactivación, cambio de rol, cambio o reset de clave) se
 * borran sus suscripciones push, en la MISMA transacción que el UPDATE. Es la contracara
 * de la revocación de sesiones de E13/ALTO-06 — sin esto, la sesión moría pero el
 * teléfono seguía recibiendo los mensajes de los clientes. (Además, enviarPushATenant
 * descarta cualquier suscripción cuyo epoch ya no coincida: defensa en profundidad.)
 */
async function borrarPushSubsDeUsuario(
  tx: Tx,
  usuarioId: string,
  tenantId?: string,
): Promise<void> {
  await tx
    .delete(waPushSubs)
    .where(tenantId ? and(eq(waPushSubs.usuarioId, usuarioId), eq(waPushSubs.tenantId, tenantId)) : eq(waPushSubs.usuarioId, usuarioId));
}

// ── Reset de contraseña desde el admin (Carril D, 0.5) ──
// A diferencia de actualizarUsuarioTenant (scopeado al dueño de SU negocio), el
// superadmin actúa cross-tenant: no hay tenantId propio con el cual filtrar el WHERE.

/**
 * Resetea la clave de un usuario del panel (superadmin, 0.5): guarda el hash de la clave
 * temporal, marca debeCambiarClave y fija su vencimiento (24h). Devuelve el usuario
 * afectado (para mostrar en qué negocio se hizo el reset), o null si no existe.
 * Lanza Error("SIN_DB") si no hay base.
 *
 * Revocación de sesiones (E13/ALTO-06): un reset de clave sube `sessionEpoch` — cualquier
 * sesión abierta con la clave vieja queda inválida de inmediato (no solo la próxima vez
 * que alguien intente loguearse con la clave vieja, sino la SESIÓN YA ABIERTA en el
 * navegador de quien sea que la tenía).
 */
export async function resetearClaveUsuario(usuarioId: string, passwordHash: string, expiraEn: Date): Promise<UsuarioTenant | null> {
  if (!hayDb) throw new Error("SIN_DB");
  // Sistema: el superadmin resetea por id de usuario, sin un negocio de sesión.
  const filas = await conSistema(obtenerDb(), async (tx) => {
    const r = await tx
      .update(waUsuarios)
      .set({ passwordHash, debeCambiarClave: true, claveTemporalExpira: expiraEn, sessionEpoch: sql`${waUsuarios.sessionEpoch} + 1` })
      .where(eq(waUsuarios.id, usuarioId))
      .returning();
    if (r[0]) await borrarPushSubsDeUsuario(tx, usuarioId);
    return r;
  });
  const f = filas[0];
  if (!f) return null;
  return { id: f.id, usuario: f.usuario, rol: f.rol as Rol, activo: f.activo, creadoEn: f.creadoEn.toISOString(), debeCambiarClave: f.debeCambiarClave };
}

/**
 * Cambio de clave propio (el usuario ya logueado, forzado o voluntario): reemplaza el
 * hash y limpia el flag de clave temporal. Scopeada por tenantId (defensa en profundidad,
 * mismo patrón que actualizarUsuarioTenant). Lanza Error("SIN_DB") si no hay base.
 *
 * Revocación de sesiones (E13/ALTO-06): sube `sessionEpoch`, igual que resetearClaveUsuario.
 * Esto invalida TAMBIÉN la sesión actual del que está cambiando su propia clave (el token
 * que trae en la cookie quedó firmado con el epoch anterior) — a propósito: es el mismo
 * criterio de seguridad que un reset ajeno, y el router no reemite cookie tras este
 * endpoint, así que el próximo request re-loguea con la clave nueva.
 */
export async function cambiarClavePropia(tenantId: string, usuarioId: string, nuevoHash: string): Promise<void> {
  if (!hayDb) throw new Error("SIN_DB");
  await conTenant(obtenerDb(), tenantId, async (tx) => {
    await tx
      .update(waUsuarios)
      .set({
        passwordHash: nuevoHash,
        debeCambiarClave: false,
        claveTemporalExpira: null,
        sessionEpoch: sql`${waUsuarios.sessionEpoch} + 1`,
      })
      .where(and(eq(waUsuarios.id, usuarioId), eq(waUsuarios.tenantId, tenantId)));
    await borrarPushSubsDeUsuario(tx, usuarioId, tenantId);
  });
}

// ── Facturación (C4.3, Stripe) — escritas por src/billing/webhook.ts ──

/**
 * Sincroniza el espejo local del estado de facturación de un tenant (plan + ids/estado de
 * Stripe), a partir de un evento de webhook ya procesado. El caller debe llamar recargar()
 * después para que el cambio quede visible sin esperar el refresco periódico (mismo
 * patrón que actualizarConfigTenant/actualizarUsuarioTenant). Lanza Error("SIN_DB") si no
 * hay base — en dev sin DB no hay dónde reflejar el webhook (no debería llamarse: el
 * endpoint del webhook ya devuelve 503 sin STRIPE_* configurado, y Stripe solo llega con
 * una base real detrás).
 */
export async function actualizarFacturacionTenant(
  tenantId: string,
  patch: {
    plan?: Plan;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    estadoFacturacion?: EstadoFacturacion;
    facturacionPeriodoFin?: Date;
  },
): Promise<void> {
  if (!hayDb) throw new Error("SIN_DB");
  await conTenant(obtenerDb(), tenantId, (tx) => tx.update(waTenants).set(patch).where(eq(waTenants.id, tenantId)));
}

/**
 * Resuelve qué tenant corresponde a un customer de Stripe (los webhooks de suscripción
 * solo traen el customer id, no nuestro tenantId). Lectura directa a la base — baja
 * frecuencia (un webhook por evento de Stripe), no pasa por el caché en memoria.
 */
export async function buscarTenantIdPorStripeCustomer(stripeCustomerId: string): Promise<string | null> {
  const filas = await conSistema(obtenerDb(), (tx) =>
    tx.select({ id: waTenants.id }).from(waTenants).where(eq(waTenants.stripeCustomerId, stripeCustomerId)).limit(1),
  );
  return filas[0]?.id ?? null;
}

// ── Recarga on-demand ante un phone_number_id desconocido ──
// El webhook la llama fire-and-forget cuando llega un número que no está en el
// caché: un negocio recién dado de alta queda disponible en el próximo mensaje, sin
// reiniciar. Con cooldown para no martillar la base ante tráfico a un número basura.
let ultimoRefrescoMiss = 0;
const COOLDOWN_MISS_MS = 10_000;
export function refrescarSiFaltaPhoneNumberId(pnid: string): void {
  if (!hayDb) return;
  if (cache.porPnid.has(pnid)) return;
  const ahora = Date.now();
  if (ahora - ultimoRefrescoMiss < COOLDOWN_MISS_MS) return;
  ultimoRefrescoMiss = ahora;
  void recargarDesdeDb();
}

/**
 * Solo para tests: registra/reemplaza una cuenta directo en el caché en memoria, sin
 * pasar por la base (E13/ALTO-06: probar `sesionDeOperador` — epoch, rol, desactivación —
 * sin levantar Postgres). Muta el caché vivo en vez de reemplazarlo por completo —
 * aceptable SOLO en tests, igual que el resto de los accesores síncronos de este módulo
 * asumen un caché ya construido (acá, típicamente vía `cargarTenants()` sin
 * DATABASE_URL, que deja el tenant fallback listo en `cache.porId`).
 */
export function _registrarUsuarioParaTests(usuario: string, cuenta: CuentaUsuario): void {
  cache.usuarios.set(usuario, cuenta);
}

/**
 * Solo para tests: registra un tenant directo en el caché en memoria, sin pasar
 * por la base, para simular un "alta" (p. ej. el reproceso de F3, que necesita
 * que un phone_number_id pase de no resolver a resolver de un momento a otro sin
 * levantar una base real). Muta el caché vivo en vez de reemplazarlo por
 * completo — aceptable SOLO en tests (en producción el caché siempre se
 * reemplaza atómico, ver `construirCache`).
 */
export function _registrarTenantParaTests(tenant: Tenant): void {
  cache.pausadosPorId.delete(tenant.id);
  cache.pausadosPorPnid.delete(tenant.phoneNumberId);
  cache.porId.set(tenant.id, tenant);
  cache.porPnid.set(tenant.phoneNumberId, tenant);
}

/**
 * Solo para tests: registra un tenant PAUSADO directo en el caché en memoria (y lo saca
 * de los índices de activos), sin pasar por la base — mismo espíritu que
 * `_registrarTenantParaTests`.
 */
export function _registrarTenantPausadoParaTests(tenant: Tenant): void {
  cache.porId.delete(tenant.id);
  cache.porPnid.delete(tenant.phoneNumberId);
  cache.pausadosPorId.set(tenant.id, tenant);
  cache.pausadosPorPnid.set(tenant.phoneNumberId, tenant);
}

/**
 * Solo para tests: fuerza la "fuente" reportada del caché (ver `fuenteCacheTenants`)
 * sin pasar por una base real. Existe para poder probar el health check de E10 en
 * el escenario "DATABASE_URL configurada pero el caché quedó en fallback" sin
 * levantar un pool de Postgres de verdad — mismo espíritu que `_registrarTenantParaTests`.
 */
export function _forzarFuenteParaTests(fuente: "db" | "fallback"): void {
  fuenteActual = fuente;
}
