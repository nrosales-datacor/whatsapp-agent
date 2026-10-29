import { and, asc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { isTenantId, withTenant, type Executor } from "../../platform/db/scope";
import { clients } from "./schema";
import { contextOf, filterConditions, type ClientFilters } from "./search";
import { notAnonymized, scopeCondition, type ClientScope } from "./service";

// ─────────────────────────────────────────────────────────────────────────────
// Consentimiento de marketing y audiencia de las campañas (I6, PLAN-GESTION.md §11).
//
// Reglas (Ley 8968 y las de Meta para mensajes de marketing):
//   • Una promoción solo va a quien consintió EXPLÍCITAMENTE (`marketing_consent_at`) y no
//     pidió la baja después (`marketing_opt_out_at`). Vale lo último que dijo: la baja borra
//     el consentimiento y un "Sí" nuevo borra la baja.
//   • Decir "No" no es una baja: solo deja constancia de que ya se le preguntó
//     (`marketing_consent_requested_at`) para no insistir.
//   • Se le pregunta UNA vez (el reclamo es atómico: dos réplicas no le preguntan dos veces).
//   • Recordatorios y avisos de servicio no dependen de nada de esto.
//
// Campañas (fuera del núcleo) arma la audiencia con los mismos filtros de la lista de
// clientes (`ClientFilters`) y vuelve a chequear cada destinatario justo antes de enviarle
// (`marketingRecipient`): alguien pudo pedir la baja entre el armado y su turno.
// ─────────────────────────────────────────────────────────────────────────────

const sameBusiness = (businessId: string, clientId: string) => and(eq(clients.businessId, businessId), eq(clients.id, clientId));

/** Puede recibir una promoción: con consentimiento, sin baja y con teléfono. */
const reachable = and(isNotNull(clients.marketingConsentAt), isNull(clients.marketingOptOutAt), isNotNull(clients.phone)) as SQL;

/**
 * Registra la respuesta del cliente a "¿te avisamos de promociones?" (botón de WhatsApp o
 * el equipo desde la ficha, con el permiso que el cliente dio en persona). `granted` true =
 * consiente (y borra una baja anterior); false = no consiente (no es una baja). Devuelve
 * false si el cliente no existe o tiene los datos eliminados.
 */
export async function recordMarketingConsent(
  executor: Executor,
  businessId: string,
  clientId: string,
  granted: boolean,
  at: Date = new Date(),
): Promise<boolean> {
  if (!isTenantId(clientId)) return false;
  const asked = sql`coalesce(${clients.marketingConsentRequestedAt}, ${at.toISOString()}::timestamptz)`;
  const changes = granted
    ? { marketingConsentAt: at, marketingOptOutAt: null, marketingConsentRequestedAt: asked }
    : { marketingConsentAt: null, marketingConsentRequestedAt: asked };
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .update(clients)
      .set(changes)
      .where(and(sameBusiness(businessId, clientId), notAnonymized))
      .returning({ id: clients.id }),
  );
  return rows.length > 0;
}

/**
 * Reclama el derecho a preguntarle por promociones: true SOLO la primera vez (nunca se le
 * preguntó y todavía no dijo nada, ni sí ni baja). Atómico: el UPDATE condicional es el
 * candado entre réplicas y reintentos.
 */
export async function claimMarketingConsentRequest(executor: Executor, businessId: string, clientId: string, at: Date = new Date()): Promise<boolean> {
  if (!isTenantId(clientId)) return false;
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .update(clients)
      .set({ marketingConsentRequestedAt: at })
      .where(
        and(
          sameBusiness(businessId, clientId),
          notAnonymized,
          isNull(clients.marketingConsentRequestedAt),
          isNull(clients.marketingConsentAt),
          isNull(clients.marketingOptOutAt),
        ),
      )
      .returning({ id: clients.id }),
  );
  return rows.length > 0;
}

/** Destinatario de una promoción, re-chequeado justo antes de enviarle. */
export interface MarketingRecipient {
  id: string;
  name: string;
  phone: string;
  preferredLocationId: string | null;
}

/** El cliente si HOY puede recibir una promoción (consentimiento, sin baja, con teléfono); si no, null. */
export async function marketingRecipient(executor: Executor, businessId: string, clientId: string): Promise<MarketingRecipient | null> {
  if (!isTenantId(clientId)) return null;
  const [row] = await withTenant(executor, businessId, (tx) =>
    tx
      .select({ id: clients.id, name: clients.name, phone: clients.phone, preferredLocationId: clients.preferredLocationId })
      .from(clients)
      .where(and(sameBusiness(businessId, clientId), notAnonymized, reachable))
      .limit(1),
  );
  return row && row.phone ? { id: row.id, name: row.name, phone: row.phone, preferredLocationId: row.preferredLocationId } : null;
}

export interface AudienceOptions {
  /** Restricción extra (p. ej. "último servicio X hace más de N meses", la arma scheduling). */
  scope?: ClientScope;
  /** Reloj (tests): el estado del cliente se calcula a esta fecha. */
  now?: Date;
}

/** Quiénes cumplen el segmento y cuántos quedan afuera, y por qué (lo muestra el panel). */
export interface MarketingAudience {
  /** Cumplen los filtros. */
  matched: number;
  /** Reciben la campaña: cumplen, consintieron, sin baja y con teléfono. */
  eligible: number;
  /** Cumplen pero nunca consintieron. */
  withoutConsent: number;
  /** Cumplen pero pidieron la baja. */
  optedOut: number;
  /** Cumplen y consintieron, pero no tienen teléfono. */
  withoutPhone: number;
  /** Algunos de los que la reciben (para que la persona vea a quién le llega). */
  sample: { id: string; name: string }[];
}

async function audienceWhere(executor: Executor, businessId: string, filters: ClientFilters, options: AudienceOptions): Promise<SQL> {
  const ctx = await contextOf(executor, businessId);
  return and(eq(clients.businessId, businessId), notAnonymized, scopeCondition(options.scope), filterConditions(ctx, filters, options.now ?? new Date())) as SQL;
}

/** Conteos del segmento y una muestra de quienes lo reciben. */
export async function previewMarketingAudience(
  executor: Executor,
  businessId: string,
  filters: ClientFilters,
  options: AudienceOptions & { sampleSize?: number } = {},
): Promise<MarketingAudience> {
  const where = await audienceWhere(executor, businessId, filters, options);
  const sampleSize = Math.min(Math.max(options.sampleSize ?? 5, 0), 20);
  return withTenant(executor, businessId, async (tx) => {
    const [counts] = await tx
      .select({
        matched: sql<number>`count(*)::int`,
        optedOut: sql<number>`(count(*) FILTER (WHERE ${clients.marketingOptOutAt} IS NOT NULL))::int`,
        withoutConsent: sql<number>`(count(*) FILTER (WHERE ${clients.marketingOptOutAt} IS NULL AND ${clients.marketingConsentAt} IS NULL))::int`,
        withoutPhone: sql<number>`(count(*) FILTER (WHERE ${clients.marketingOptOutAt} IS NULL AND ${clients.marketingConsentAt} IS NOT NULL AND ${clients.phone} IS NULL))::int`,
        eligible: sql<number>`(count(*) FILTER (WHERE ${reachable}))::int`,
      })
      .from(clients)
      .where(where);
    const sample =
      sampleSize > 0
        ? await tx
            .select({ id: clients.id, name: clients.name })
            .from(clients)
            .where(and(where, reachable))
            .orderBy(asc(clients.name), asc(clients.id))
            .limit(sampleSize)
        : [];
    return {
      matched: Number(counts?.matched ?? 0),
      eligible: Number(counts?.eligible ?? 0),
      withoutConsent: Number(counts?.withoutConsent ?? 0),
      optedOut: Number(counts?.optedOut ?? 0),
      withoutPhone: Number(counts?.withoutPhone ?? 0),
      sample,
    };
  });
}

/** Tope de destinatarios de una campaña (una campaña más grande se parte en varias). */
export const MAX_CAMPAIGN_AUDIENCE = 20_000;

/**
 * Ids de quienes reciben la campaña (cumplen el segmento y hoy pueden recibir promociones),
 * en orden estable, hasta `MAX_CAMPAIGN_AUDIENCE`. Pasá la transacción del llamador para
 * que el armado quede junto con el alta de los envíos.
 */
export async function listMarketingAudienceIds(executor: Executor, businessId: string, filters: ClientFilters, options: AudienceOptions = {}): Promise<string[]> {
  const where = await audienceWhere(executor, businessId, filters, options);
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select({ id: clients.id })
      .from(clients)
      .where(and(where, reachable))
      .orderBy(asc(clients.name), asc(clients.id))
      .limit(MAX_CAMPAIGN_AUDIENCE),
  );
  return rows.map((r) => r.id);
}

/** Resumen del negocio: cuántos clientes aceptaron promociones y cuántos pidieron la baja. */
export async function marketingConsentSummary(executor: Executor, businessId: string): Promise<{ clients: number; consented: number; optedOut: number }> {
  const [row] = await withTenant(executor, businessId, (tx) =>
    tx
      .select({
        clients: sql<number>`count(*)::int`,
        consented: sql<number>`(count(*) FILTER (WHERE ${clients.marketingConsentAt} IS NOT NULL AND ${clients.marketingOptOutAt} IS NULL))::int`,
        optedOut: sql<number>`(count(*) FILTER (WHERE ${clients.marketingOptOutAt} IS NOT NULL))::int`,
      })
      .from(clients)
      .where(and(eq(clients.businessId, businessId), notAnonymized)),
  );
  return { clients: Number(row?.clients ?? 0), consented: Number(row?.consented ?? 0), optedOut: Number(row?.optedOut ?? 0) };
}
