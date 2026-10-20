import { asc, eq } from "drizzle-orm";
import { withTenant, type Executor } from "../../platform/db/scope";
import { msFromEnv } from "../../platform/net/timeouts";
import { businesses, locationHours, locations, type Business, type Location, type LocationHour } from "./schema";
import {
  DEFAULT_CLIENT_STATUS_RULES,
  DEFAULT_TERMINOLOGY,
  REMINDER_CHANNELS,
  type ClientStatusRules,
  type ReminderChannel,
  type Terminology,
} from "./settings";

// ─────────────────────────────────────────────────────────────────────────────
// Caché del contexto de UN negocio (PLAN-GESTION.md §1, "Se rehace"): lo que casi toda
// request y cada turno del agente necesitan (negocio, sucursales con su horario,
// terminología, reglas de estado de cliente, canales de recordatorio), leído bajo demanda
// y guardado poco tiempo. Reemplaza al caché viejo que cargaba TODOS los negocios en cada
// proceso y lo recargaba cada 60 s.
//
//   • LRU acotado (`maxEntries`): la memoria no crece con la cantidad de negocios.
//   • TTL corto (BUSINESS_CACHE_TTL_MS, default 30 s): es lo máximo que otro proceso (web
//     vs. worker, o varias réplicas) puede ver una config vieja. En el proceso que hizo el
//     cambio, `invalidateBusinessContext` lo hace visible al instante.
//   • Una sola lectura en vuelo por negocio: una ráfaga de requests del mismo negocio con
//     el caché frío espera la MISMA consulta, no dispara N.
//   • Lo devuelto es compartido y está congelado (Object.freeze profundo): no se muta.
//   • Un negocio inexistente no se guarda (null no ocupa lugar ni tapa un alta posterior).
//
// Pasale la base (`Db`), no una transacción que está escribiendo la config: lo leído
// adentro de una transacción sin confirmar no debe quedar en el caché.
// ─────────────────────────────────────────────────────────────────────────────

export interface LocationWithHours extends Location {
  /** Horario semanal de la sucursal, por día (0 = domingo) y hora de apertura. */
  hours: readonly LocationHour[];
}

export interface BusinessContext {
  business: Business;
  /** Todas las sucursales (activas e inactivas), en el orden del negocio. */
  locations: readonly LocationWithHours[];
  /** Terminología completa: lo del negocio sobre los defaults. */
  terminology: Terminology;
  /** Reglas de estado de cliente completas: lo del negocio sobre los defaults. */
  clientStatusRules: ClientStatusRules;
  /** Canales activos de recordatorio, en orden de preferencia (el primero es el default). */
  reminderChannels: readonly ReminderChannel[];
}

export interface BusinessContextCacheOptions {
  /** Vida de una entrada (ms). Default: BUSINESS_CACHE_TTL_MS o 30 s. */
  ttlMs?: number;
  /** Entradas como máximo; al pasarse se descarta la usada hace más tiempo. Default 500. */
  maxEntries?: number;
  /** Reloj en ms (para tests). Default `Date.now`. */
  now?: () => number;
}

export interface BusinessContextCache {
  get(executor: Executor, businessId: string): Promise<BusinessContext | null>;
  invalidate(businessId: string): void;
  clear(): void;
  /** Entradas guardadas ahora (incluye lecturas en vuelo). */
  readonly size: number;
}

const DEFAULT_TTL_MS = msFromEnv("BUSINESS_CACHE_TTL_MS", 30_000);
const DEFAULT_MAX_ENTRIES = 500;

/** Lee el contexto de la base, con el alcance RLS del negocio. null si no existe. */
export async function loadBusinessContext(executor: Executor, businessId: string): Promise<BusinessContext | null> {
  return withTenant(executor, businessId, async (tx) => {
    const [business] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
    if (!business) return null;
    const locs = await tx
      .select()
      .from(locations)
      .where(eq(locations.businessId, businessId))
      .orderBy(asc(locations.position), asc(locations.createdAt));
    const hours = await tx
      .select()
      .from(locationHours)
      .where(eq(locationHours.businessId, businessId))
      .orderBy(asc(locationHours.weekday), asc(locationHours.opensAt));
    return buildContext(business, locs, hours);
  });
}

function buildContext(business: Business, locs: Location[], hours: LocationHour[]): BusinessContext {
  const byLocation = new Map<string, LocationHour[]>();
  for (const h of hours) {
    const list = byLocation.get(h.locationId);
    if (list) list.push(h);
    else byLocation.set(h.locationId, [h]);
  }
  const channels = business.reminderChannels.filter((c): c is ReminderChannel =>
    (REMINDER_CHANNELS as readonly string[]).includes(c),
  );
  return deepFreeze({
    business,
    locations: locs.map((l) => ({ ...l, hours: byLocation.get(l.id) ?? [] })),
    terminology: { ...DEFAULT_TERMINOLOGY, ...definedOnly(business.terminology) },
    clientStatusRules: { ...DEFAULT_CLIENT_STATUS_RULES, ...definedOnly(business.clientStatusRules) },
    // La base solo acepta canales conocidos (CHECK); el filtro es defensa extra. Vacío =
    // el negocio no manda recordatorios (no se completa con el default).
    reminderChannels: [...new Set(channels)],
  });
}

/** Saca las claves en undefined para que no pisen los defaults al hacer el spread. */
function definedOnly<T extends object>(partial: T): Partial<T> {
  return Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Crea un caché independiente (el del proceso es el de `getBusinessContext`). */
export function createBusinessContextCache(options: BusinessContextCacheOptions = {}): BusinessContextCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const now = options.now ?? Date.now;
  // Map conserva el orden de inserción: la primera clave es la usada hace más tiempo.
  const entries = new Map<string, { expiresAt: number; value: Promise<BusinessContext | null> }>();

  function get(executor: Executor, businessId: string): Promise<BusinessContext | null> {
    const t = now();
    const hit = entries.get(businessId);
    if (hit && hit.expiresAt > t) {
      entries.delete(businessId);
      entries.set(businessId, hit);
      return hit.value;
    }
    entries.delete(businessId);
    const entry = { expiresAt: t + ttlMs, value: loadBusinessContext(executor, businessId) };
    entries.set(businessId, entry);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
    // Ni un error ni un negocio inexistente se quedan guardados. Solo se borra ESTA
    // entrada: si mientras tanto se invalidó y ya hay otra lectura, esa se respeta.
    const forget = () => {
      if (entries.get(businessId) === entry) entries.delete(businessId);
    };
    entry.value.then((ctx) => {
      if (ctx === null) forget();
    }, forget);
    return entry.value;
  }

  return {
    get,
    invalidate: (businessId) => void entries.delete(businessId),
    clear: () => entries.clear(),
    get size() {
      return entries.size;
    },
  };
}

const processCache = createBusinessContextCache();

/** Contexto del negocio desde el caché del proceso (lo lee de la base si no está o venció). */
export function getBusinessContext(executor: Executor, businessId: string): Promise<BusinessContext | null> {
  return processCache.get(executor, businessId);
}

/**
 * Descarta el contexto guardado de un negocio en ESTE proceso. Llamalo después de
 * confirmar cualquier cambio de lo que trae el contexto (negocio, sucursales, horarios).
 * Los demás procesos lo ven al vencer el TTL.
 */
export function invalidateBusinessContext(businessId: string): void {
  processCache.invalidate(businessId);
}
