import { and, eq } from "drizzle-orm";
import type { Bloqueo, EstadoFacturacion, HorarioDia, KnowledgeBase, Plan, Rol, Service, Tenant } from "../types";
import { crearDb } from "../db/client";
import { waTenants, waUsuarios } from "../db/schema";
import { TENANT_FALLBACK_SELYON } from "./tenants";
import { normalizarKb } from "./validadores";

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

interface CuentaUsuario {
  id: string;
  tenantId: string;
  passwordHash: string;
  /** Rol dentro del negocio (C2.3): "dueno" edita "Mi negocio" y gestiona usuarios. */
  rol: Rol;
  /** Reset de contraseña desde el admin (Carril D, 0.5): fuerza el cambio al loguearse. */
  debeCambiarClave: boolean;
  /** Vencimiento de la clave temporal (0.5). Null = clave normal. */
  claveTemporalExpira: Date | null;
}

interface Cache {
  porPnid: Map<string, Tenant>;
  porId: Map<string, Tenant>;
  usuarios: Map<string, CuentaUsuario>;
}

// Caché vivo. Se reemplaza ENTERO de forma atómica en cada recarga (nunca se muta
// in-place, para no servir un caché a medio llenar).
let cache: Cache = construirCache([], []);
let hayDb = false;

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
  }[],
): Cache {
  const porPnid = new Map<string, Tenant>();
  const porId = new Map<string, Tenant>();
  for (const t of tenants) {
    porId.set(t.id, t);
    porPnid.set(t.phoneNumberId, t);
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
    });
  }
  return { porPnid, porId, usuarios: us };
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
    });
  }
  return construirCache([t], usuarios);
}

function filaATenant(f: typeof waTenants.$inferSelect): Tenant {
  return {
    id: f.id,
    nombre: f.nombre,
    phoneNumberId: f.phoneNumberId,
    accessToken: f.accessToken ?? undefined,
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
    linkResenas: f.linkResenas ?? undefined,
    plantillaMarketing: f.plantillaMarketing ?? undefined,
    plantillaReapertura: f.plantillaReapertura ?? undefined,
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
    tipoNegocio: f.tipoNegocio ?? undefined,
    pais: f.pais ?? undefined,
    formasPago: f.formasPago ?? undefined,
    registro: (f.registro as Tenant["registro"]) ?? undefined,
    tono: f.tono ?? undefined,
    instrucciones: f.instrucciones ?? undefined,
  };
}

let db: ReturnType<typeof crearDb> | null = null;
function obtenerDb() {
  if (!db) db = crearDb();
  return db;
}

async function recargarDesdeDb(): Promise<void> {
  try {
    const d = obtenerDb();
    const tenants = await d.select().from(waTenants).where(eq(waTenants.activo, true));
    const usuarios = await d.select().from(waUsuarios).where(eq(waUsuarios.activo, true));
    if (tenants.length === 0) {
      activarFallback("la base no tiene tenants activos");
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
      })),
    );
  } catch (e) {
    activarFallback(`no se pudo leer la base (${e instanceof Error ? e.message : String(e)})`);
  }
}

// Cae al fallback SOLO si todavía no hay nada cargado (arranque con base vacía /
// inalcanzable). Si ya hay un caché válido (p. ej. un refresh que falló), se
// conserva — nunca tiramos tenants buenos por un blip de red.
function activarFallback(motivo: string): void {
  if (cache.porId.size > 0) {
    console.error(`[tenantStore] ⚠️ ${motivo}; conservo el caché actual (${cache.porId.size} tenant/s).`);
    return;
  }
  cache = cacheFallback();
  console.error(
    `[tenantStore] ⚠️ ${motivo} — usando fallback hardcodeado 'rosales'. ` +
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
  hayDb = !!process.env.DATABASE_URL;
  if (!hayDb) {
    cache = cacheFallback();
    console.log(`[tenantStore] sin DATABASE_URL: ${cache.porId.size} tenant(s) en memoria (fallback).`);
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
  return !!process.env.DATABASE_URL;
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
  const d = obtenerDb();
  await d.transaction(async (tx) => {
    await tx.insert(waTenants).values({
      id: tenant.id,
      nombre: tenant.nombre,
      phoneNumberId: tenant.phoneNumberId,
      accessToken: tenant.accessToken ?? null,
      timezone: tenant.timezone,
      moneda: tenant.moneda,
      ubicacion: tenant.ubicacion,
      intervaloAgendaMin: tenant.intervaloAgendaMin,
      horario: tenant.horario,
      servicios: tenant.servicios,
      kb: tenant.kb,
      bloqueos: tenant.bloqueos,
      linkResenas: tenant.linkResenas ?? null,
      plantillaMarketing: tenant.plantillaMarketing ?? null,
      plantillaReapertura: tenant.plantillaReapertura ?? null,
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
    });
    // El usuario del alta es, por definición, el dueño del negocio recién creado.
    await tx.insert(waUsuarios).values({ usuario: u.usuario, passwordHash: u.passwordHash, tenantId: tenant.id, rol: "dueno" });
  });
}

/**
 * Actualiza la config self-service de un negocio (ROADMAP C2.2): horario, servicios, kb y
 * bloqueos, como un reemplazo completo (mismo patrón "blob JSONB entero" que crearTenant).
 * El caller debe llamar recargar() después para que el cambio quede visible sin esperar el
 * refresco periódico. Lanza Error("SIN_DB") si no hay base.
 */
export async function actualizarConfigTenant(
  tenantId: string,
  patch: {
    horario: Record<number, HorarioDia>;
    servicios: Service[];
    kb: KnowledgeBase;
    bloqueos: Bloqueo[];
    linkResenas: string | null;
    plantillaMarketing: string | null;
    plantillaReapertura: string | null;
    colorAcento: string | null;
    colorHeader: string | null;
    logoUrl: string | null;
    rescateActivo: boolean;
    rescateHorasEspera: number;
    rescateToque1Texto: string | null;
    rescateToque2Texto: string | null;
    rescatePlantilla: string | null;
    googlePlaceId: string | null;
    tipoNegocio: string | null;
    pais: string | null;
    formasPago: string | null;
    registro: string | null;
    tono: string | null;
    instrucciones: string | null;
  },
): Promise<void> {
  if (!hayDb) throw new Error("SIN_DB");
  const d = obtenerDb();
  await d
    .update(waTenants)
    .set({
      horario: patch.horario,
      servicios: patch.servicios,
      kb: patch.kb,
      bloqueos: patch.bloqueos,
      linkResenas: patch.linkResenas,
      plantillaMarketing: patch.plantillaMarketing,
      plantillaReapertura: patch.plantillaReapertura,
      colorAcento: patch.colorAcento,
      colorHeader: patch.colorHeader,
      logoUrl: patch.logoUrl,
      rescateActivo: patch.rescateActivo,
      rescateHorasEspera: patch.rescateHorasEspera,
      rescateToque1Texto: patch.rescateToque1Texto,
      rescateToque2Texto: patch.rescateToque2Texto,
      rescatePlantilla: patch.rescatePlantilla,
      googlePlaceId: patch.googlePlaceId,
      tipoNegocio: patch.tipoNegocio,
      pais: patch.pais,
      formasPago: patch.formasPago,
      registro: patch.registro,
      tono: patch.tono,
      instrucciones: patch.instrucciones,
      actualizadoEn: new Date(),
    })
    .where(eq(waTenants.id, tenantId));
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
  const d = obtenerDb();
  const filas = await d.select().from(waUsuarios).where(eq(waUsuarios.tenantId, tenantId));
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
  const d = obtenerDb();
  await d.insert(waUsuarios).values({ usuario: u.usuario, passwordHash: u.passwordHash, tenantId, rol: u.rol });
}

/**
 * Actualiza rol y/o estado activo de un usuario del panel. Scopeada por tenantId en el
 * WHERE (defensa en profundidad: un dueño no puede tocar usuarios de otro negocio aunque
 * conozca el id). El guard de "al menos un dueño activo" lo valida el router ANTES de
 * llamar acá (necesita leer el resto del equipo para decidir). Lanza Error("SIN_DB") si
 * no hay base.
 */
export async function actualizarUsuarioTenant(
  tenantId: string,
  usuarioId: string,
  patch: { rol?: Rol; activo?: boolean },
): Promise<void> {
  if (!hayDb) throw new Error("SIN_DB");
  const d = obtenerDb();
  await d
    .update(waUsuarios)
    .set(patch)
    .where(and(eq(waUsuarios.id, usuarioId), eq(waUsuarios.tenantId, tenantId)));
}

// ── Reset de contraseña desde el admin (Carril D, 0.5) ──
// A diferencia de actualizarUsuarioTenant (scopeado al dueño de SU negocio), el
// superadmin actúa cross-tenant: no hay tenantId propio con el cual filtrar el WHERE.

/**
 * Resetea la clave de un usuario del panel (superadmin, 0.5): guarda el hash de la clave
 * temporal, marca debeCambiarClave y fija su vencimiento (24h). Devuelve el usuario
 * afectado (para mostrar en qué negocio se hizo el reset), o null si no existe.
 * Lanza Error("SIN_DB") si no hay base.
 */
export async function resetearClaveUsuario(usuarioId: string, passwordHash: string, expiraEn: Date): Promise<UsuarioTenant | null> {
  if (!hayDb) throw new Error("SIN_DB");
  const d = obtenerDb();
  const filas = await d
    .update(waUsuarios)
    .set({ passwordHash, debeCambiarClave: true, claveTemporalExpira: expiraEn })
    .where(eq(waUsuarios.id, usuarioId))
    .returning();
  const f = filas[0];
  if (!f) return null;
  return { id: f.id, usuario: f.usuario, rol: f.rol as Rol, activo: f.activo, creadoEn: f.creadoEn.toISOString(), debeCambiarClave: f.debeCambiarClave };
}

/**
 * Cambio de clave propio (el usuario ya logueado, forzado o voluntario): reemplaza el
 * hash y limpia el flag de clave temporal. Scopeada por tenantId (defensa en profundidad,
 * mismo patrón que actualizarUsuarioTenant). Lanza Error("SIN_DB") si no hay base.
 */
export async function cambiarClavePropia(tenantId: string, usuarioId: string, nuevoHash: string): Promise<void> {
  if (!hayDb) throw new Error("SIN_DB");
  const d = obtenerDb();
  await d
    .update(waUsuarios)
    .set({ passwordHash: nuevoHash, debeCambiarClave: false, claveTemporalExpira: null })
    .where(and(eq(waUsuarios.id, usuarioId), eq(waUsuarios.tenantId, tenantId)));
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
  const d = obtenerDb();
  await d.update(waTenants).set(patch).where(eq(waTenants.id, tenantId));
}

/**
 * Resuelve qué tenant corresponde a un customer de Stripe (los webhooks de suscripción
 * solo traen el customer id, no nuestro tenantId). Lectura directa a la base — baja
 * frecuencia (un webhook por evento de Stripe), no pasa por el caché en memoria.
 */
export async function buscarTenantIdPorStripeCustomer(stripeCustomerId: string): Promise<string | null> {
  const d = obtenerDb();
  const filas = await d.select({ id: waTenants.id }).from(waTenants).where(eq(waTenants.stripeCustomerId, stripeCustomerId)).limit(1);
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
