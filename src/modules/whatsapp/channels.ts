import { and, asc, eq, isNotNull, ne } from "drizzle-orm";
import { recordAudit } from "../../platform/audit/auditLog";
import { decrypt, encrypt } from "../../platform/crypto/secrets";
import { isTenantId, withSystem, withTenant, type Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import { alertPlatform, forgetAlert } from "../../platform/observability/alerts";
import { log } from "../../platform/observability/log";
import { assertLocationsOfBusiness, getBusinessContext } from "../business";
import { GraphError, type ChannelCredentials, type MetaSignupApi, type WhatsAppApi } from "./graph";
import { whatsappChannels, type ChannelTemplate, type ChannelTemplates, type WhatsappChannel } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Números de WhatsApp conectados (`whatsapp_channels`): alta por Embedded Signup o por el
// superadmin, configuración (sucursal y plantillas aprobadas), prueba del token y el
// ruteo del webhook (`phone_number_id` → canal → negocio).
//
// El token del WABA se guarda CIFRADO (src/platform/crypto/secrets.ts) y nunca sale por la
// API: la vista solo dice si está vigente.
//
// Estado del token: Meta lo rechaza con 401 / código 190 cuando el dueño cambió la clave
// de Facebook, quitó la app o venció. Entonces el canal pasa a `disconnected` (los
// recordatorios caen al correo, la bandeja lo muestra "vencido") y sale una alerta a la
// plataforma; la primera respuesta OK lo vuelve a `active`. Se escribe solo en los cambios
// de estado, no en cada envío.
// ─────────────────────────────────────────────────────────────────────────────

/** Vigencia del token, para el panel. */
export type TokenStatus = "valid" | "expired" | "missing";

export interface ChannelView {
  id: string;
  phoneNumberId: string;
  wabaId: string | null;
  displayPhone: string | null;
  /** null = atiende todas las sucursales (el agente pregunta cuál). */
  locationId: string | null;
  templates: ChannelTemplates;
  status: string;
  tokenStatus: TokenStatus;
  createdAt: string;
  updatedAt: string;
}

export function tokenStatusOf(row: Pick<WhatsappChannel, "status" | "accessTokenEncrypted">): TokenStatus {
  if (!row.accessTokenEncrypted) return "missing";
  return row.status === "disconnected" ? "expired" : "valid";
}

export function toChannelView(row: WhatsappChannel): ChannelView {
  return {
    id: row.id,
    phoneNumberId: row.phoneNumberId,
    wabaId: row.wabaId,
    displayPhone: row.displayPhone,
    locationId: row.locationId,
    templates: row.templates ?? {},
    status: row.status,
    tokenStatus: tokenStatusOf(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Credenciales para Graph (token descifrado), o null si el canal no tiene token. */
export function credentialsOf(row: WhatsappChannel): ChannelCredentials | null {
  if (!row.accessTokenEncrypted) return null;
  return { channelId: row.id, businessId: row.businessId, phoneNumberId: row.phoneNumberId, accessToken: decrypt(row.accessTokenEncrypted) };
}

const notFound = () => new HttpError(404, "No encontramos ese número de WhatsApp.", "not_found");

// ── Lectura ──────────────────────────────────────────────────────────────────

export async function listChannelRows(db: Executor, businessId: string): Promise<WhatsappChannel[]> {
  return withTenant(db, businessId, (tx) =>
    tx.select().from(whatsappChannels).where(eq(whatsappChannels.businessId, businessId)).orderBy(asc(whatsappChannels.createdAt)),
  );
}

export async function listChannels(db: Executor, businessId: string): Promise<ChannelView[]> {
  return (await listChannelRows(db, businessId)).map(toChannelView);
}

export async function getChannelRow(db: Executor, businessId: string, channelId: string): Promise<WhatsappChannel | null> {
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .select()
      .from(whatsappChannels)
      .where(and(eq(whatsappChannels.businessId, businessId), eq(whatsappChannels.id, channelId)))
      .limit(1),
  );
  return row ?? null;
}

/** ¿El negocio tiene un número conectado y con el token vigente? (canal del recordatorio) */
export async function isWhatsAppConnected(db: Executor, businessId: string): Promise<boolean> {
  const rows = await listChannelRows(db, businessId);
  return rows.some((r) => r.status === "active" && r.accessTokenEncrypted);
}

/**
 * Negocios con al menos un número conectado (activo y con token), de toda la plataforma:
 * lo usa el superadmin para "agente encendido" en las métricas de producto (I5).
 */
export async function listConnectedWhatsAppBusinessIds(db: Executor): Promise<Set<string>> {
  const rows = await withSystem(db, (tx) =>
    tx
      .selectDistinct({ businessId: whatsappChannels.businessId })
      .from(whatsappChannels)
      .where(and(eq(whatsappChannels.status, "active"), isNotNull(whatsappChannels.accessTokenEncrypted))),
  );
  return new Set(rows.map((r) => r.businessId));
}

/**
 * Número con el que se le escribe a un cliente de la sucursal `locationId`: el activo de
 * esa sucursal, si no el activo que atiende todas, si no cualquiera activo. null si no hay.
 */
export async function channelForLocation(db: Executor, businessId: string, locationId: string | null): Promise<WhatsappChannel | null> {
  const active = (await listChannelRows(db, businessId)).filter((r) => r.status === "active" && r.accessTokenEncrypted);
  return active.find((r) => locationId && r.locationId === locationId) ?? active.find((r) => r.locationId === null) ?? active[0] ?? null;
}

// ── Ruteo del webhook (contexto de sistema, con caché corto) ─────────────────

export interface RoutedChannel {
  id: string;
  businessId: string;
  locationId: string | null;
  status: string;
}

const ROUTE_TTL_MS = 30_000;
const MAX_ROUTES = 2000;
const routes = new Map<string, { value: RoutedChannel; expiresAt: number }>();

/**
 * Canal dueño de un `phone_number_id` (cross-tenant por diseño: el webhook todavía no sabe
 * de qué negocio es). Los aciertos se cachean 30 s; los fallos no (un número recién
 * conectado se ve en el mensaje siguiente).
 */
export async function resolveChannelByPhoneNumberId(db: Executor, phoneNumberId: string, now: number = Date.now()): Promise<RoutedChannel | null> {
  const cached = routes.get(phoneNumberId);
  if (cached && cached.expiresAt > now) return cached.value;
  const [row] = await withSystem(db, (tx) =>
    tx
      .select({ id: whatsappChannels.id, businessId: whatsappChannels.businessId, locationId: whatsappChannels.locationId, status: whatsappChannels.status })
      .from(whatsappChannels)
      .where(eq(whatsappChannels.phoneNumberId, phoneNumberId))
      .limit(1),
  );
  if (!row) {
    routes.delete(phoneNumberId);
    return null;
  }
  routes.delete(phoneNumberId);
  routes.set(phoneNumberId, { value: row, expiresAt: now + ROUTE_TTL_MS });
  while (routes.size > MAX_ROUTES) {
    const oldest = routes.keys().next().value;
    if (oldest === undefined) break;
    routes.delete(oldest);
  }
  return row;
}

/** Olvida el ruteo cacheado (alta, cambio de sucursal). */
export function invalidateChannelRouting(phoneNumberId?: string): void {
  if (phoneNumberId) routes.delete(phoneNumberId);
  else routes.clear();
}

// ── Estado del token ─────────────────────────────────────────────────────────

const TOKEN_ALERT = "whatsapp_token_invalid";
/** Última vigencia conocida por canal en ESTE proceso: solo se escribe al cambiar. */
const knownTokenState = new Map<string, boolean>();

/** Marca el canal según la última respuesta de Graph (no lanza). */
export async function recordTokenStatus(db: Executor, channel: { channelId: string; businessId: string }, valid: boolean): Promise<void> {
  // Llamadas sin canal guardado todavía (el alta por Embedded Signup) no tienen qué marcar.
  if (!isTenantId(channel.channelId) || !isTenantId(channel.businessId)) return;
  if (knownTokenState.get(channel.channelId) === valid) return;
  knownTokenState.set(channel.channelId, valid);
  try {
    if (valid) {
      await withTenant(db, channel.businessId, (tx) =>
        tx
          .update(whatsappChannels)
          .set({ status: "active" })
          .where(and(eq(whatsappChannels.id, channel.channelId), eq(whatsappChannels.status, "disconnected"))),
      );
      forgetAlert(TOKEN_ALERT, channel.businessId);
      return;
    }
    await withTenant(db, channel.businessId, (tx) =>
      tx
        .update(whatsappChannels)
        .set({ status: "disconnected" })
        .where(and(eq(whatsappChannels.id, channel.channelId), ne(whatsappChannels.status, "disconnected"))),
    );
    alertPlatform({
      type: TOKEN_ALERT,
      tenantId: channel.businessId,
      severity: "critical",
      message: "Meta rechazó el token de WhatsApp de este negocio: el bot no puede responder hasta que reconecte el número.",
      data: { channelId: channel.channelId },
      // La condición no se arregla sola: recordar cada 6 h, no en cada envío.
      cooldownMs: 6 * 60 * 60_000,
    });
  } catch (e) {
    knownTokenState.delete(channel.channelId);
    log.error("whatsapp_token_status_failed", { businessId: channel.businessId, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Solo para tests. */
export function _resetChannelStateForTests(): void {
  routes.clear();
  knownTokenState.clear();
}

// ── Alta ─────────────────────────────────────────────────────────────────────

export interface NewChannelInput {
  phoneNumberId: string;
  wabaId?: string | null;
  displayPhone?: string | null;
  accessToken?: string | null;
  locationId?: string | null;
}

/**
 * Crea el canal del negocio o, si el número ya era suyo, le renueva el token (reconectar).
 * 409 `channel_taken` si el número está conectado a OTRO negocio.
 */
async function upsertChannel(db: Executor, businessId: string, input: NewChannelInput): Promise<{ row: WhatsappChannel; created: boolean }> {
  const [owner] = await withSystem(db, (tx) =>
    tx
      .select({ id: whatsappChannels.id, businessId: whatsappChannels.businessId })
      .from(whatsappChannels)
      .where(eq(whatsappChannels.phoneNumberId, input.phoneNumberId))
      .limit(1),
  );
  if (owner && owner.businessId !== businessId) {
    throw new HttpError(409, "Ese número de WhatsApp ya está conectado a otro negocio.", "channel_taken");
  }
  if (input.locationId) await assertLocationsOfBusiness(db, businessId, [input.locationId], "body.locationId");
  const token = input.accessToken?.trim() || null;
  const values = {
    wabaId: input.wabaId ?? null,
    displayPhone: input.displayPhone ?? null,
    accessTokenEncrypted: token ? encrypt(token) : null,
    status: token ? "active" : "pending",
  };
  const result = await withTenant(db, businessId, async (tx) => {
    if (owner) {
      const [row] = await tx
        .update(whatsappChannels)
        .set({
          // Reconectar sin token nuevo no borra el que había.
          ...(token ? { accessTokenEncrypted: values.accessTokenEncrypted, status: "active" } : {}),
          ...(input.wabaId ? { wabaId: input.wabaId } : {}),
          ...(input.displayPhone ? { displayPhone: input.displayPhone } : {}),
          ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(whatsappChannels.businessId, businessId), eq(whatsappChannels.id, owner.id)))
        .returning();
      return { row, created: false };
    }
    const [row] = await tx
      .insert(whatsappChannels)
      .values({ businessId, phoneNumberId: input.phoneNumberId, locationId: input.locationId ?? null, ...values })
      .returning();
    return { row, created: true };
  });
  invalidateChannelRouting(input.phoneNumberId);
  knownTokenState.delete(result.row.id);
  return result;
}

/** Alta manual del superadmin (cuando el negocio no pasa por el Embedded Signup). */
export async function createChannelByAdmin(db: Executor, actor: string, businessId: string, input: NewChannelInput): Promise<ChannelView> {
  if (!(await getBusinessContext(db, businessId))) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  const { row, created } = await upsertChannel(db, businessId, input);
  await recordAudit(db, businessId, created ? "whatsapp_channel_created" : "whatsapp_channel_reconnected", actor, {
    channelId: row.id,
    phoneNumberId: row.phoneNumberId,
    withToken: Boolean(row.accessTokenEncrypted),
  });
  return toChannelView(row);
}

export interface ConnectInput {
  code: string;
  /** Lo que devuelve el SDK de Meta en el evento del popup (opcional: si falta se descubre con el token). */
  phoneNumberId?: string;
  wabaId?: string;
  locationId?: string | null;
}

/**
 * Embedded Signup: canjea el código del popup por el token del WABA, resuelve el número,
 * suscribe la app a los webhooks del WABA y registra el número (las dos últimas son
 * best-effort: se pueden rehacer a mano desde WhatsApp Manager).
 */
export async function connectChannel(
  db: Executor,
  signup: MetaSignupApi & Pick<WhatsAppApi, "getPhoneNumber">,
  actor: string,
  businessId: string,
  input: ConnectInput,
): Promise<ChannelView> {
  let token: string;
  try {
    token = await signup.exchangeCode(input.code);
  } catch (e) {
    log.warn("whatsapp_signup_exchange_failed", { businessId, error: e instanceof Error ? e.message : String(e) });
    throw new HttpError(400, "Meta no aceptó la conexión (el código venció o la app no está bien configurada). Probá de nuevo.", "signup_failed");
  }

  let wabaId = input.wabaId ?? null;
  let phoneNumberId = input.phoneNumberId ?? null;
  let displayPhone: string | null = null;
  try {
    if (!wabaId) wabaId = (await signup.listWhatsAppAccounts(token))[0] ?? null;
    if (!phoneNumberId && wabaId) phoneNumberId = (await signup.listPhoneNumbers(wabaId, token))[0]?.id ?? null;
    if (phoneNumberId) {
      const info = await signup.getPhoneNumber({ channelId: "signup", businessId, phoneNumberId, accessToken: token });
      displayPhone = info.displayPhone;
    }
  } catch (e) {
    if (!(e instanceof GraphError)) throw e;
    log.warn("whatsapp_signup_lookup_failed", { businessId, status: e.status ?? null });
  }
  if (!phoneNumberId) {
    throw new HttpError(400, "No encontramos el número de WhatsApp en la cuenta conectada. Elegí un número en el paso de Meta.", "signup_no_number");
  }

  const subscribed = wabaId ? await signup.subscribeApp(wabaId, token) : false;
  const registered = await signup.registerNumber(phoneNumberId, token);
  const { row, created } = await upsertChannel(db, businessId, {
    phoneNumberId,
    wabaId,
    displayPhone,
    accessToken: token,
    locationId: input.locationId,
  });
  await recordAudit(db, businessId, created ? "whatsapp_channel_connected" : "whatsapp_channel_reconnected", actor, {
    channelId: row.id,
    phoneNumberId,
    subscribed,
    registered,
  });
  return toChannelView(row);
}

// ── Configuración y prueba ───────────────────────────────────────────────────

export interface ChannelPatch {
  locationId?: string | null;
  /** Por clave: una plantilla la fija, null la quita; las claves ausentes no se tocan. */
  templates?: Partial<Record<keyof ChannelTemplates, ChannelTemplate | null>>;
}

export async function updateChannel(db: Executor, businessId: string, channelId: string, patch: ChannelPatch): Promise<ChannelView> {
  const current = await getChannelRow(db, businessId, channelId);
  if (!current) throw notFound();
  if (patch.locationId) await assertLocationsOfBusiness(db, businessId, [patch.locationId], "body.locationId");
  const changes: Partial<typeof whatsappChannels.$inferInsert> = {};
  if (patch.locationId !== undefined) changes.locationId = patch.locationId;
  if (patch.templates) {
    const templates: ChannelTemplates = { ...(current.templates ?? {}) };
    for (const [key, value] of Object.entries(patch.templates) as [keyof ChannelTemplates, ChannelTemplate | null | undefined][]) {
      if (value === undefined) continue;
      if (value === null) delete templates[key];
      else templates[key] = { name: value.name.trim(), language: value.language.trim() };
    }
    changes.templates = templates;
  }
  if (Object.keys(changes).length === 0) return toChannelView(current);
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .update(whatsappChannels)
      .set(changes)
      .where(and(eq(whatsappChannels.businessId, businessId), eq(whatsappChannels.id, channelId)))
      .returning(),
  );
  invalidateChannelRouting(row.phoneNumberId);
  return toChannelView(row);
}

export interface ChannelTestResult {
  ok: boolean;
  tokenStatus: TokenStatus;
  displayPhone: string | null;
  verifiedName: string | null;
}

/** Prueba el token contra Meta (lee los datos del número) y deja el estado al día. */
export async function testChannel(db: Executor, api: Pick<WhatsAppApi, "getPhoneNumber">, businessId: string, channelId: string): Promise<ChannelTestResult> {
  const row = await getChannelRow(db, businessId, channelId);
  if (!row) throw notFound();
  const credentials = credentialsOf(row);
  if (!credentials) return { ok: false, tokenStatus: "missing", displayPhone: row.displayPhone, verifiedName: null };
  try {
    const info = await api.getPhoneNumber(credentials);
    await recordTokenStatus(db, { channelId: row.id, businessId }, true);
    // Primera prueba OK de un canal pendiente: queda activo. Se actualiza el número visible.
    await withTenant(db, businessId, (tx) =>
      tx
        .update(whatsappChannels)
        .set({ status: "active", ...(info.displayPhone ? { displayPhone: info.displayPhone } : {}) })
        .where(and(eq(whatsappChannels.businessId, businessId), eq(whatsappChannels.id, row.id))),
    );
    return { ok: true, tokenStatus: "valid", displayPhone: info.displayPhone ?? row.displayPhone, verifiedName: info.verifiedName };
  } catch (e) {
    if (!(e instanceof GraphError)) throw e;
    if (e.tokenInvalid) {
      knownTokenState.delete(row.id);
      await recordTokenStatus(db, { channelId: row.id, businessId }, false);
      return { ok: false, tokenStatus: "expired", displayPhone: row.displayPhone, verifiedName: null };
    }
    throw new HttpError(502, "No pudimos comunicarnos con WhatsApp. Probá de nuevo en un momento.", "whatsapp_unavailable");
  }
}
