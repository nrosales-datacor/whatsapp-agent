import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { recordAudit } from "../../platform/audit/auditLog";
import { isTenantId, withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { HttpError, ValidationError } from "../../platform/http/errors";
import { applyCustomDataPatch, getBusinessContext, listCustomFields, type BusinessContext } from "../business";
import { listStaffOptions } from "../team";
import { DEFAULT_PHONE_COUNTRY, normalizePhone } from "./phone";
import { clients, type Client, type ClientChannel } from "./schema";
import { computeClientStatus, isVip, type ClientStatus } from "./status";

// ─────────────────────────────────────────────────────────────────────────────
// Servicio del módulo clients: alta, edición, lectura, "buscar o crear por teléfono" (lo
// usa el agente de WhatsApp), caché de visitas/gasto (la mantienen Agenda y Ventas) y el
// derecho de supresión (Ley 8968). Todo pasa por `withTenant`: con la base corriendo como
// `app_runtime`, un negocio no ve ni toca clientes de otro.
//
// Cada función recibe un `Executor`: la base o una transacción ya abierta del llamador
// (p. ej. completar una cita y refrescar la caché del cliente en la MISMA transacción).
// ─────────────────────────────────────────────────────────────────────────────

/** Nombre con el que queda la fila de un cliente cuyos datos se eliminaron. */
export const ANONYMIZED_CLIENT_NAME = "Cliente eliminado";

const PHONE_UNIQUE_INDEX = "clients_business_phone_uq";

/** Cliente tal como lo ven el panel y los demás módulos. Fechas en ISO 8601. */
export interface ClientView {
  id: string;
  name: string;
  /** E.164 ("+50688887777") o null. */
  phone: string | null;
  email: string | null;
  /** "AAAA-MM-DD". */
  birthDate: string | null;
  /** Responsable (p. ej. de un menor): otro cliente del negocio. */
  guardianId: string | null;
  notes: string | null;
  tags: string[];
  source: string | null;
  preferredLocationId: string | null;
  preferredStaffId: string | null;
  /** Canal preferido para recordatorios (null = el default del negocio). */
  preferredChannel: ClientChannel | null;
  /** VIP manual (además del VIP que sale de las reglas, ver `ClientDetail.isVip`). */
  vip: boolean;
  /** Valores de los campos personalizados (`clave → valor`; definiciones en Configuración). */
  customData: Record<string, unknown>;
  marketingConsentAt: string | null;
  marketingOptOutAt: string | null;
  visitCount: number;
  firstVisitAt: string | null;
  lastVisitAt: string | null;
  totalSpentCents: number;
  /** true = se eliminaron sus datos personales (queda la fila para el historial). */
  anonymized: boolean;
  /** Cuándo se eliminaron (ISO 8601), o null. */
  anonymizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Referencia corta a otro cliente (responsable o menor a cargo). */
export interface ClientRef {
  id: string;
  name: string;
}

/** Ficha completa (`GET /clients/:id`): el cliente, su responsable y a quiénes tiene a cargo. */
export interface ClientDetail extends ClientView {
  guardian: ClientRef | null;
  dependents: ClientRef[];
  /** Estado calculado (./status.ts); null sin el CRM completo (plan Básico). */
  status: ClientStatus | null;
  /** VIP manual o por reglas; null sin el CRM completo. */
  isVip: boolean | null;
}

/**
 * Qué clientes ve quien consulta: todos (undefined), ninguno ("none") o los que cumplen
 * una condición SQL sobre `clients` (p. ej. "Mis clientes" del profesional: los que tienen
 * citas suyas; la subconsulta la arma scheduling y la inyecta la composición).
 */
export type ClientScope = SQL | "none" | undefined;

/** Alcance "clientes cuyo id está en esta subconsulta" (p. ej. los que tienen citas con un profesional). */
export function clientIdIn(subquery: SQL): SQL {
  return sql`${clients.id} IN (${subquery})`;
}

/** Condición SQL del alcance (undefined = sin restricción). */
export function scopeCondition(scope: ClientScope): SQL | undefined {
  if (scope === undefined) return undefined;
  if (scope === "none") return sql`false`;
  return scope;
}

/** Caché de visitas y gasto (PLAN-GESTION.md §4): la base del estado del cliente. */
export interface ClientStats {
  visitCount: number;
  firstVisitAt: Date | null;
  lastVisitAt: Date | null;
  totalSpentCents: number;
}

/** Datos editables de un cliente (ya validados en forma por la ruta; `null` = vaciar). */
export interface ClientInput {
  name: string;
  phone: string | null;
  email: string | null;
  birthDate: string | null;
  notes: string | null;
  tags: string[];
  source: string | null;
  preferredLocationId: string | null;
  preferredStaffId: string | null;
  preferredChannel: ClientChannel | null;
  guardianId: string | null;
  /** VIP manual (CRM del Pro: la ruta lo permite solo con el nivel `full`). */
  vip?: boolean;
  /** Cambios de campos personalizados (CRM del Pro): solo las claves presentes; null/"" borra. */
  customData?: Record<string, unknown>;
}

/** Cambios de un PATCH: solo las claves presentes se tocan. */
export type ClientPatch = Partial<ClientInput>;

// ── Vistas ──────────────────────────────────────────────────────────────────

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function isAnonymized(row: Pick<Client, "anonymizedAt">): boolean {
  return row.anonymizedAt !== null && row.anonymizedAt !== undefined;
}

export function toClientView(row: Client): ClientView {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    birthDate: row.birthDate,
    guardianId: row.guardianId,
    notes: row.notes,
    tags: row.tags ?? [],
    source: row.source,
    preferredLocationId: row.preferredLocationId,
    preferredStaffId: row.preferredStaffId,
    preferredChannel: (row.preferredChannel as ClientChannel | null) ?? null,
    vip: row.vip,
    customData: row.customData ?? {},
    marketingConsentAt: iso(row.marketingConsentAt),
    marketingOptOutAt: iso(row.marketingOptOutAt),
    visitCount: row.visitCount,
    firstVisitAt: iso(row.firstVisitAt),
    lastVisitAt: iso(row.lastVisitAt),
    totalSpentCents: row.totalSpentCents,
    anonymized: isAnonymized(row),
    anonymizedAt: iso(row.anonymizedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Errores ─────────────────────────────────────────────────────────────────

function notFound(ctx: BusinessContext | null): HttpError {
  const term = ctx?.terminology.client ?? "cliente";
  return new HttpError(404, `No encontramos ese ${term}.`, "not_found");
}

function phoneTaken(ctx: BusinessContext, existingName?: string): HttpError {
  const who = existingName ? ` (${existingName})` : "";
  return new HttpError(409, `Ya hay un ${ctx.terminology.client} con ese teléfono${who}.`, "phone_taken");
}

/** ¿El error (o alguno de su cadena de `cause`) es la violación de este índice único? Drizzle envuelve el de Postgres. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let i = 0; current && i < 5; i++) {
    const e = current as { code?: string; constraint?: string; constraint_name?: string; message?: string; cause?: unknown };
    if (e.code === "23505" && [e.constraint, e.constraint_name, e.message].some((v) => String(v ?? "").includes(constraint))) {
      return true;
    }
    current = e.cause;
  }
  return false;
}

async function businessContext(executor: Executor, businessId: string): Promise<BusinessContext> {
  const ctx = await getBusinessContext(executor, businessId);
  if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  return ctx;
}

/** País de los números locales del negocio (Costa Rica si no tiene uno conocido). */
function phoneCountry(ctx: BusinessContext): string {
  return ctx.business.country || DEFAULT_PHONE_COUNTRY;
}

const sameBusiness = (businessId: string, clientId: string) => and(eq(clients.businessId, businessId), eq(clients.id, clientId));

// ── Lectura ─────────────────────────────────────────────────────────────────

/** Un cliente del negocio, o null si no existe (o el id no es un uuid). */
export async function getClient(executor: Executor, businessId: string, clientId: string): Promise<ClientView | null> {
  if (!isTenantId(clientId)) return null;
  const [row] = await withTenant(executor, businessId, (tx) => tx.select().from(clients).where(sameBusiness(businessId, clientId)).limit(1));
  return row ? toClientView(row) : null;
}

/** Varios clientes del negocio por id (los que no existen se omiten; sin orden garantizado). */
export async function getClientsByIds(executor: Executor, businessId: string, clientIds: readonly string[]): Promise<ClientView[]> {
  const ids = [...new Set(clientIds.filter(isTenantId).map((id) => id.toLowerCase()))];
  if (ids.length === 0) return [];
  const rows = await withTenant(executor, businessId, (tx) =>
    tx.select().from(clients).where(and(eq(clients.businessId, businessId), inArray(clients.id, ids))),
  );
  return rows.map(toClientView);
}

export interface ClientDetailOptions {
  /** Con el CRM completo (Pro) la ficha trae estado y VIP calculados. Default false. */
  crm?: boolean;
  /** Alcance de quien consulta (un cliente fuera de alcance responde 404). */
  scope?: ClientScope;
  /** Reloj (tests). */
  now?: Date;
}

/** Ficha completa: el cliente con su responsable y sus menores a cargo. Lanza 404 si no existe (o está fuera del alcance). */
export async function getClientDetail(
  executor: Executor,
  businessId: string,
  clientId: string,
  options: ClientDetailOptions = {},
): Promise<ClientDetail> {
  const ctx = await businessContext(executor, businessId);
  if (!isTenantId(clientId)) throw notFound(ctx);
  return withTenant(executor, businessId, async (tx) => {
    const [row] = await tx
      .select()
      .from(clients)
      .where(and(sameBusiness(businessId, clientId), scopeCondition(options.scope)))
      .limit(1);
    if (!row) throw notFound(ctx);
    const guardian = row.guardianId
      ? ((await tx.select({ id: clients.id, name: clients.name }).from(clients).where(sameBusiness(businessId, row.guardianId)).limit(1))[0] ??
        null)
      : null;
    const dependents = await tx
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(and(eq(clients.businessId, businessId), eq(clients.guardianId, clientId)))
      .orderBy(asc(clients.name));
    const rules = ctx.clientStatusRules;
    const crm = Boolean(options.crm) && !isAnonymized(row);
    return {
      ...toClientView(row),
      guardian,
      dependents,
      status: crm ? computeClientStatus(row, rules, options.now) : null,
      isVip: crm ? isVip(row, rules) : null,
    };
  });
}

/** ¿El cliente existe y entra en el alcance? (p. ej. el profesional y sus clientes). */
export async function isClientInScope(executor: Executor, businessId: string, clientId: string, scope: ClientScope): Promise<boolean> {
  if (!isTenantId(clientId)) return false;
  const [row] = await withTenant(executor, businessId, (tx) =>
    tx
      .select({ id: clients.id })
      .from(clients)
      .where(and(sameBusiness(businessId, clientId), scopeCondition(scope)))
      .limit(1),
  );
  return Boolean(row);
}

/**
 * Cliente por teléfono, en cualquier forma que se escriba ("8888 7777", "+506…",
 * "50688887777"): se normaliza con el país del negocio. null si no hay o no es un teléfono.
 */
export async function findClientByPhone(executor: Executor, businessId: string, phone: string): Promise<ClientView | null> {
  const ctx = await businessContext(executor, businessId);
  const e164 = normalizePhone(phone, phoneCountry(ctx));
  if (!e164) return null;
  const [row] = await withTenant(executor, businessId, (tx) =>
    tx.select().from(clients).where(and(eq(clients.businessId, businessId), eq(clients.phone, e164))).limit(1),
  );
  return row ? toClientView(row) : null;
}

// ── Buscar o crear (agente de WhatsApp, Agenda) ─────────────────────────────

export interface FindOrCreateInput {
  phone: string;
  /** Nombre si el cliente es nuevo (p. ej. el del perfil de WhatsApp). Uno existente conserva el suyo. */
  name?: string | null;
  /** De dónde llegó, si es nuevo ("WhatsApp", "Agenda"…). */
  source?: string | null;
}

/** Nombre de un cliente nuevo que llegó sin nombre (se edita después en su ficha). */
export const UNNAMED_CLIENT = "Sin nombre";

/**
 * Cliente con ese teléfono, o uno nuevo si no existe. Idempotente y segura ante carreras:
 * dos llamadas a la vez con el mismo teléfono (dos mensajes seguidos de WhatsApp) terminan
 * en el MISMO cliente (`INSERT … ON CONFLICT DO NOTHING` sobre el índice único por negocio
 * y teléfono, y si chocó, se lee el que ganó). Lanza `ValidationError` si el teléfono no es
 * válido.
 */
export async function findOrCreateClientByPhone(
  executor: Executor,
  businessId: string,
  input: FindOrCreateInput,
): Promise<{ client: ClientView; created: boolean }> {
  const ctx = await businessContext(executor, businessId);
  const phone = normalizePhone(input.phone, phoneCountry(ctx));
  if (!phone) throw new ValidationError({ phone: "Número de teléfono inválido." });
  const name = input.name?.trim().slice(0, 120) || UNNAMED_CLIENT;
  const source = input.source?.trim().slice(0, 60) || null;

  return withTenant(executor, businessId, async (tx) => {
    // Un conflicto con una fila que justo se borra entre el INSERT y el SELECT deja el SELECT
    // vacío: se reintenta (en la segunda vuelta ya no choca).
    for (let attempt = 0; attempt < 3; attempt++) {
      const inserted = await tx
        .insert(clients)
        .values({ businessId, name, phone, source })
        .onConflictDoNothing({ target: [clients.businessId, clients.phone] })
        .returning();
      if (inserted.length > 0) return { client: toClientView(inserted[0]), created: true };
      const [existing] = await tx
        .select()
        .from(clients)
        .where(and(eq(clients.businessId, businessId), eq(clients.phone, phone)))
        .limit(1);
      if (existing) return { client: toClientView(existing), created: false };
    }
    throw new Error("findOrCreateClientByPhone: no se pudo insertar ni encontrar el cliente");
  });
}

// ── Alta y edición (panel) ──────────────────────────────────────────────────

/** Etiquetas sin repetir (sin distinguir mayúsculas), en el orden en que llegaron. */
function uniqueTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const t = tag.trim();
    const key = t.toLocaleLowerCase("es");
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Valida lo que no se puede validar solo con la forma: teléfono en E.164 con el país del
 * negocio, sucursal y profesional del negocio, responsable válido y canal coherente.
 * Devuelve los cambios listos para escribir. `current` = la fila actual (en un PATCH).
 */
async function resolveChanges(
  tx: Tx,
  ctx: BusinessContext,
  businessId: string,
  patch: ClientPatch,
  current: Client | null,
): Promise<Partial<Client>> {
  const fields: Record<string, string> = {};
  const changes: Partial<Client> = {};
  const term = ctx.terminology.client;

  if (patch.name !== undefined) changes.name = patch.name.trim();
  if (patch.email !== undefined) changes.email = patch.email ? patch.email.trim().toLowerCase() : null;
  if (patch.birthDate !== undefined) changes.birthDate = patch.birthDate;
  if (patch.notes !== undefined) changes.notes = patch.notes;
  if (patch.source !== undefined) changes.source = patch.source;
  if (patch.tags !== undefined) changes.tags = uniqueTags(patch.tags);
  if (patch.preferredChannel !== undefined) changes.preferredChannel = patch.preferredChannel;
  if (patch.vip !== undefined) changes.vip = patch.vip;

  // Campos personalizados: solo las claves enviadas, contra las definiciones activas; los
  // obligatorios tienen que quedar cargados (el formulario de la ficha manda todos).
  if (patch.customData !== undefined) {
    const definitions = await listCustomFields(tx, businessId, { entity: "client" });
    const { data, errors } = applyCustomDataPatch(definitions, current?.customData ?? {}, patch.customData);
    if (Object.keys(errors).length > 0) Object.assign(fields, errors);
    else changes.customData = data;
  }

  if (patch.phone !== undefined) {
    if (patch.phone === null) changes.phone = null;
    else {
      const e164 = normalizePhone(patch.phone, phoneCountry(ctx));
      if (e164) changes.phone = e164;
      else fields["body.phone"] = "Número de teléfono inválido. Si es de otro país, empezá con + y el código del país.";
    }
  }

  if (patch.preferredLocationId !== undefined) {
    const id = patch.preferredLocationId?.toLowerCase() ?? null;
    if (id && !ctx.locations.some((l) => l.id === id)) fields["body.preferredLocationId"] = `Esa ${ctx.terminology.location} no existe en el negocio.`;
    else changes.preferredLocationId = id;
  }

  if (patch.preferredStaffId !== undefined) {
    const id = patch.preferredStaffId?.toLowerCase() ?? null;
    if (id) {
      const staffIds = new Set((await listStaffOptions(tx, businessId)).map((s) => s.id));
      if (!staffIds.has(id)) fields["body.preferredStaffId"] = `Ese ${ctx.terminology.staffMember} no existe en el negocio.`;
      else changes.preferredStaffId = id;
    } else changes.preferredStaffId = null;
  }

  if (patch.guardianId !== undefined) {
    const id = patch.guardianId?.toLowerCase() ?? null;
    if (!id) changes.guardianId = null;
    else if (current && id === current.id) fields["body.guardianId"] = `Un ${term} no puede ser su propio responsable.`;
    else {
      const [guardian] = await tx.select().from(clients).where(sameBusiness(businessId, id)).limit(1);
      if (!guardian || isAnonymized(guardian)) fields["body.guardianId"] = `Ese ${term} no existe en el negocio.`;
      else if (guardian.guardianId) fields["body.guardianId"] = `El responsable no puede tener a su vez un responsable.`;
      else if (current) {
        const [dependent] = await tx
          .select({ id: clients.id })
          .from(clients)
          .where(and(eq(clients.businessId, businessId), eq(clients.guardianId, current.id)))
          .limit(1);
        if (dependent) fields["body.guardianId"] = `Este ${term} es responsable de otros: no puede tener un responsable.`;
        else changes.guardianId = id;
      } else changes.guardianId = id;
    }
  }

  // Coherencia del resultado: recordatorios por correo solo con correo cargado.
  const email = changes.email !== undefined ? changes.email : (current?.email ?? null);
  const channel = changes.preferredChannel !== undefined ? changes.preferredChannel : (current?.preferredChannel ?? null);
  if (channel === "email" && !email && !fields["body.email"]) {
    fields["body.preferredChannel"] = "Para avisarle por correo, primero cargá su correo.";
  }

  if (Object.keys(fields).length > 0) throw new ValidationError(fields);
  return changes;
}

/** Ya hay otro cliente con ese teléfono → 409 `phone_taken` (con su nombre, del mismo negocio). */
async function assertPhoneFree(tx: Tx, ctx: BusinessContext, businessId: string, phone: string | null | undefined, selfId?: string) {
  if (!phone) return;
  const [other] = await tx
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(and(eq(clients.businessId, businessId), eq(clients.phone, phone)))
    .limit(1);
  if (other && other.id !== selfId) throw phoneTaken(ctx, other.name);
}

/** Alta desde el panel. Lanza 400 por campo, o 409 `phone_taken` si el teléfono ya es de otro cliente. */
export async function createClient(executor: Executor, businessId: string, input: ClientInput): Promise<ClientView> {
  const ctx = await businessContext(executor, businessId);
  try {
    return await withTenant(executor, businessId, async (tx) => {
      const values = await resolveChanges(tx, ctx, businessId, input, null);
      await assertPhoneFree(tx, ctx, businessId, values.phone);
      const [row] = await tx
        .insert(clients)
        .values({ ...values, businessId, name: values.name ?? input.name.trim() })
        .returning();
      return toClientView(row);
    });
  } catch (error) {
    if (isUniqueViolation(error, PHONE_UNIQUE_INDEX)) throw phoneTaken(ctx);
    throw error;
  }
}

/** Edición desde el panel (solo las claves presentes). Un cliente con los datos eliminados no se edita (409). */
export async function updateClient(executor: Executor, businessId: string, clientId: string, patch: ClientPatch): Promise<ClientView> {
  const ctx = await businessContext(executor, businessId);
  if (!isTenantId(clientId)) throw notFound(ctx);
  try {
    return await withTenant(executor, businessId, async (tx) => {
      const [current] = await tx.select().from(clients).where(sameBusiness(businessId, clientId)).limit(1).for("update");
      if (!current) throw notFound(ctx);
      if (isAnonymized(current)) {
        throw new HttpError(409, `Los datos de este ${ctx.terminology.client} se eliminaron: ya no se puede editar.`, "client_anonymized");
      }
      const changes = await resolveChanges(tx, ctx, businessId, patch, current);
      if (changes.phone !== undefined && changes.phone !== current.phone) await assertPhoneFree(tx, ctx, businessId, changes.phone, clientId);
      if (Object.keys(changes).length === 0) return toClientView(current);
      const [row] = await tx.update(clients).set(changes).where(sameBusiness(businessId, clientId)).returning();
      return toClientView(row);
    });
  } catch (error) {
    if (isUniqueViolation(error, PHONE_UNIQUE_INDEX)) throw phoneTaken(ctx);
    throw error;
  }
}

// ── Caché de visitas y gasto (Agenda y Ventas) ──────────────────────────────

function assertStats(stats: Partial<ClientStats>): void {
  const count = (n: number | undefined, what: string) => {
    if (n !== undefined && !(Number.isSafeInteger(n) && n >= 0)) throw new Error(`refreshClientStats: ${what} debe ser un entero ≥ 0`);
  };
  const instant = (d: Date | null | undefined, what: string) => {
    if (d !== undefined && d !== null && Number.isNaN(d.getTime())) throw new Error(`refreshClientStats: ${what} no es una fecha válida`);
  };
  count(stats.visitCount, "visitCount");
  count(stats.totalSpentCents, "totalSpentCents");
  instant(stats.firstVisitAt, "firstVisitAt");
  instant(stats.lastVisitAt, "lastVisitAt");
  if (stats.firstVisitAt && stats.lastVisitAt && stats.firstVisitAt > stats.lastVisitAt) {
    throw new Error("refreshClientStats: firstVisitAt no puede ser posterior a lastVisitAt");
  }
}

/**
 * Fija la caché de visitas y gasto del cliente con valores ABSOLUTOS que el dueño de cada
 * dato calcula desde SUS tablas: Agenda manda `visitCount`/`firstVisitAt`/`lastVisitAt`
 * (citas completadas) y Ventas `totalSpentCents` (pagos menos devoluciones). Solo se tocan
 * las claves presentes. Al ser absolutos (no incrementos), repetir la llamada no desvía
 * nada. Pasá la transacción que completa la cita o registra el pago para que caché y
 * operación queden juntas. Devuelve false si el cliente no existe.
 */
export async function refreshClientStats(
  executor: Executor,
  businessId: string,
  clientId: string,
  stats: Partial<ClientStats>,
): Promise<boolean> {
  assertStats(stats);
  const changes: Partial<Client> = {};
  if (stats.visitCount !== undefined) changes.visitCount = stats.visitCount;
  if (stats.firstVisitAt !== undefined) changes.firstVisitAt = stats.firstVisitAt;
  if (stats.lastVisitAt !== undefined) changes.lastVisitAt = stats.lastVisitAt;
  if (stats.totalSpentCents !== undefined) changes.totalSpentCents = stats.totalSpentCents;
  if (Object.keys(changes).length === 0 || !isTenantId(clientId)) return false;
  const rows = await withTenant(executor, businessId, (tx) =>
    tx.update(clients).set(changes).where(sameBusiness(businessId, clientId)).returning({ id: clients.id }),
  );
  return rows.length > 0;
}

// ── Baja de promociones (agente de WhatsApp: "BAJA") ────────────────────────

/**
 * El cliente pidió no recibir más promociones: marca la baja y retira el consentimiento de
 * marketing (vale lo último que dijo). No toca recordatorios ni la atención normal. Pasá
 * la transacción del llamador para que quede junto con su propio registro. Devuelve false
 * si el cliente no existe.
 */
export async function recordMarketingOptOut(
  executor: Executor,
  businessId: string,
  clientId: string,
  at: Date = new Date(),
): Promise<boolean> {
  if (!isTenantId(clientId)) return false;
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .update(clients)
      .set({ marketingOptOutAt: at, marketingConsentAt: null })
      .where(sameBusiness(businessId, clientId))
      .returning({ id: clients.id }),
  );
  return rows.length > 0;
}

// ── Derecho de supresión (Ley 8968) ─────────────────────────────────────────

/**
 * Borra los datos personales que OTRO módulo guarda de un cliente (p. ej. WhatsApp: sus
 * conversaciones y mensajes), dentro de la misma transacción que la anonimización. Devuelve
 * conteos para el rastro de auditoría (nunca datos personales). Se inyecta desde la
 * composición (src/routes.ts): el núcleo no importa los módulos de afuera.
 */
export type ClientDataEraser = (tx: Tx, target: { businessId: string; clientId: string }) => Promise<Record<string, number> | void>;

export interface AnonymizeOptions {
  /** Actor del rastro de auditoría (`userActor(userId)`). */
  actor: string;
  /** Lo que la persona escribió para confirmar: el teléfono del cliente (o su nombre si no tiene). */
  confirmation: string;
  erasers?: readonly ClientDataEraser[];
}

/**
 * Elimina los datos personales del cliente y deja la fila como "Cliente eliminado": las
 * citas y pagos que la referencian siguen enteros (y los reportes cuadran), pero ya no se
 * puede saber de quién eran. Se borran nombre, teléfono, correo, nacimiento, notas,
 * etiquetas, origen, campos personalizados, preferencias, consentimientos y el vínculo con
 * su responsable y sus menores a cargo; se conserva la caché de visitas y gasto (números
 * sin datos personales). Queda en `audit_log` con el id interno y conteos, nada personal.
 */
export async function anonymizeClient(
  executor: Executor,
  businessId: string,
  clientId: string,
  options: AnonymizeOptions,
): Promise<ClientView> {
  const ctx = await businessContext(executor, businessId);
  if (!isTenantId(clientId)) throw notFound(ctx);
  return withTenant(executor, businessId, async (tx) => {
    const [current] = await tx.select().from(clients).where(sameBusiness(businessId, clientId)).limit(1).for("update");
    if (!current) throw notFound(ctx);
    if (isAnonymized(current)) {
      throw new HttpError(409, `Los datos de este ${ctx.terminology.client} ya se eliminaron.`, "client_anonymized");
    }

    // Confirmación fuerte: repetir el teléfono (en cualquier forma) o, sin teléfono, el nombre.
    const confirmed = current.phone
      ? normalizePhone(options.confirmation, phoneCountry(ctx)) === current.phone
      : options.confirmation.trim().toLocaleLowerCase("es") === current.name.trim().toLocaleLowerCase("es");
    if (!confirmed) {
      throw new ValidationError({
        "body.confirmation": current.phone ? "El teléfono no coincide." : `El nombre no coincide con el del ${ctx.terminology.client}.`,
      });
    }

    const erased: Record<string, number> = {};
    for (const eraser of options.erasers ?? []) Object.assign(erased, (await eraser(tx, { businessId, clientId })) ?? {});

    const unlinked = await tx
      .update(clients)
      .set({ guardianId: null })
      .where(and(eq(clients.businessId, businessId), eq(clients.guardianId, clientId)))
      .returning({ id: clients.id });

    const [row] = await tx
      .update(clients)
      .set({
        name: ANONYMIZED_CLIENT_NAME,
        phone: null,
        email: null,
        birthDate: null,
        guardianId: null,
        notes: null,
        tags: [],
        source: null,
        customData: {},
        anonymizedAt: new Date(),
        preferredLocationId: null,
        preferredStaffId: null,
        preferredChannel: null,
        vip: false,
        marketingConsentAt: null,
        marketingOptOutAt: null,
        marketingConsentRequestedAt: null,
      })
      .where(sameBusiness(businessId, clientId))
      .returning();

    // Sin datos personales: id interno y conteos (src/platform/db/schema.ts, `audit_log`).
    await recordAudit(tx, businessId, "client_anonymized", options.actor, {
      ...erased,
      clientId,
      unlinkedDependents: unlinked.length,
    });
    return toClientView(row);
  });
}

// SQL que comparten la búsqueda y la vista (ver ./search.ts).
export const notAnonymized = isNull(clients.anonymizedAt);
