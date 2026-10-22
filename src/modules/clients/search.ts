import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";
import { rowsOf } from "../../platform/db/rows";
import { isTenantId, withTenant, type Executor } from "../../platform/db/scope";
import { HttpError, ValidationError } from "../../platform/http/errors";
import { getBusinessContext, type BusinessContext } from "../business";
import { phoneDigits } from "./phone";
import { clients, type Client } from "./schema";
import { notAnonymized, scopeCondition, type ClientScope } from "./service";
import { CLIENT_STATUSES, clientStatusSql, vipSql, type ClientStatus } from "./status";

// ─────────────────────────────────────────────────────────────────────────────
// Lista, filtros y búsqueda de clientes (`GET /clients`, chips de estado, exportación y,
// en I6, los segmentos de Campañas): por nombre, teléfono o correo; por estado, etiquetas,
// rango de última visita, profesional y sucursal preferidos y VIP; ordenada por nombre,
// última visita, gasto o visitas, con paginación por cursor (keyset: estable aunque entren
// clientes nuevos mientras se pagina, y sin OFFSET que se ponga lento).
//
// El estado se calcula EN LA CONSULTA (./status.ts) con las reglas del negocio: filtrar y
// contar por estado no necesita columnas guardadas ni recalcular nada.
//
// Nombre sin tildes ni mayúsculas ("maria" encuentra a "María") con `translate` + `lower`
// (sin extensiones: PGlite y Supabase igual). La misma expresión ordena la lista, así
// "Ángela" queda con las A y no después de la Z. Los clientes con los datos eliminados no
// aparecen (su fila queda solo para el historial de citas y pagos).
// ─────────────────────────────────────────────────────────────────────────────

export const CLIENT_SORTS = ["name", "last_visit", "total_spent", "visit_count"] as const;
export type ClientSort = (typeof CLIENT_SORTS)[number];

/** Orden de la ficha básica (los dos planes); los demás son del CRM completo. */
export const BASIC_CLIENT_SORTS: readonly ClientSort[] = ["name", "last_visit"];

/**
 * Filtros de la lista (y de un segmento de Campañas). Todos opcionales y combinables (Y);
 * dentro de `statuses` y `tags`, cualquiera de los valores (O).
 */
export interface ClientFilters {
  /** Texto libre: palabras del nombre, parte del correo o dígitos del teléfono. */
  q?: string;
  statuses?: readonly ClientStatus[];
  /** Tiene al menos una de estas etiquetas (tal como están escritas). */
  tags?: readonly string[];
  /** Última visita desde este día ("AAAA-MM-DD", en la zona del negocio), inclusive. */
  lastVisitFrom?: string;
  /** Última visita hasta este día ("AAAA-MM-DD", en la zona del negocio), inclusive. */
  lastVisitTo?: string;
  preferredStaffId?: string;
  preferredLocationId?: string;
  /** true = solo VIP (manual o por reglas); false = solo no VIP. */
  vip?: boolean;
}

export interface ListClientsInput extends ClientFilters {
  sort?: ClientSort;
  /** `nextCursor` de la página anterior. */
  cursor?: string;
  /** Default 50, máximo 100. */
  limit?: number;
}

export interface ListClientsOptions {
  /** Alcance de quien consulta (p. ej. "Mis clientes" del profesional). */
  scope?: ClientScope;
  /** Calcular estado y VIP en cada fila (CRM completo). Default false. */
  withStatus?: boolean;
  /** Reloj (tests). */
  now?: Date;
}

/** Fila de la lista. */
export interface ClientSummary {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  tags: string[];
  visitCount: number;
  lastVisitAt: string | null;
  totalSpentCents: number;
  /** Estado calculado; null sin el CRM completo. */
  status: ClientStatus | null;
  /** VIP manual o por reglas; null sin el CRM completo. */
  isVip: boolean | null;
}

export interface ClientPage {
  items: ClientSummary[];
  /** Cursor de la página siguiente, o null si no hay más. */
  nextCursor: string | null;
}

/** Cantidad por estado con los filtros dados (sin el de estado): los chips de la lista. */
export type ClientStatusCounts = Record<ClientStatus, number> & { total: number };

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
const MAX_TERMS = 6;

// Letras con tilde → sin tilde. Mismo largo en las dos (lo exige `translate`).
const ACCENTED = "ÁÀÂÄÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇáàâäãéèêëíìîïóòôöõúùûüñç";
const PLAIN = "AAAAAEEEEIIIIOOOOOUUUUNCaaaaaeeeeiiiiooooouuuunc";
if ([...ACCENTED].length !== [...PLAIN].length) throw new Error("clients/search: ACCENTED y PLAIN deben tener el mismo largo");

/** Nombre sin tildes y en minúsculas: clave de búsqueda y de orden. */
const nameKey = sql<string>`lower(translate(${clients.name}, ${sql.raw(`'${ACCENTED}'`)}, ${sql.raw(`'${PLAIN}'`)}))`;
/** `last_visit_at` como texto de Postgres: viaja en el cursor sin perder microsegundos. */
const lastVisitText = sql<string | null>`${clients.lastVisitAt}::text`;

/** Lo mismo que `nameKey`, del lado de JS, para lo que escribe la persona. */
function foldText(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Escapa los comodines de LIKE (`%`, `_` y la barra, que es el escape por defecto). */
function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Cada palabra tiene que aparecer en el nombre, el correo o (si tiene dígitos) el teléfono. */
function searchCondition(q: string | undefined): SQL | undefined {
  const terms = (q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, MAX_TERMS);
  if (terms.length === 0) return undefined;
  return and(
    ...terms.map((term) => {
      const folded = likeContains(foldText(term));
      const digits = phoneDigits(term);
      const options: SQL[] = [sql`${nameKey} LIKE ${folded}`, sql`lower(${clients.email}) LIKE ${folded}`];
      if (digits.length >= 3) options.push(sql`${clients.phone} LIKE ${likeContains(digits)}`);
      return or(...options) as SQL;
    }),
  );
}

/** ¿El filtro usa algo del CRM completo? (estado, etiquetas, visitas, preferidos, VIP u otro orden). */
export function usesCrmFilters(input: ListClientsInput): boolean {
  return (
    (input.statuses?.length ?? 0) > 0 ||
    (input.tags?.length ?? 0) > 0 ||
    input.lastVisitFrom !== undefined ||
    input.lastVisitTo !== undefined ||
    input.preferredStaffId !== undefined ||
    input.preferredLocationId !== undefined ||
    input.vip !== undefined ||
    (input.sort !== undefined && !BASIC_CLIENT_SORTS.includes(input.sort))
  );
}

/** Condiciones de los filtros (sin cursor ni alcance). */
function filterConditions(ctx: BusinessContext, filters: ClientFilters, now: Date): SQL | undefined {
  const rules = ctx.clientStatusRules;
  const tz = ctx.business.timezone;
  const conditions: (SQL | undefined)[] = [searchCondition(filters.q)];
  if (filters.statuses?.length) {
    const wanted = [...new Set(filters.statuses)];
    conditions.push(sql`${clientStatusSql(rules, now)} IN (${sql.join(wanted.map((s) => sql`${s}`), sql`, `)})`);
  }
  if (filters.tags?.length) {
    const tags = [...new Set(filters.tags)];
    conditions.push(sql`${clients.tags} ?| ARRAY[${sql.join(tags.map((t) => sql`${t}`), sql`, `)}]::text[]`);
  }
  const localDay = sql`(${clients.lastVisitAt} AT TIME ZONE ${tz})::date`;
  if (filters.lastVisitFrom) conditions.push(sql`${localDay} >= ${filters.lastVisitFrom}::date`);
  if (filters.lastVisitTo) conditions.push(sql`${localDay} <= ${filters.lastVisitTo}::date`);
  if (filters.preferredStaffId) conditions.push(eq(clients.preferredStaffId, filters.preferredStaffId.toLowerCase()));
  if (filters.preferredLocationId) conditions.push(eq(clients.preferredLocationId, filters.preferredLocationId.toLowerCase()));
  if (filters.vip !== undefined) conditions.push(filters.vip ? vipSql(rules) : sql`NOT ${vipSql(rules)}`);
  return and(...conditions);
}

async function contextOf(executor: Executor, businessId: string): Promise<BusinessContext> {
  const ctx = await getBusinessContext(executor, businessId);
  if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  return ctx;
}

// ── Cursor ──────────────────────────────────────────────────────────────────

type Cursor =
  | { s: "name"; k: string; id: string }
  | { s: "last_visit"; v: string | null; k: string; id: string }
  | { s: "total_spent" | "visit_count"; n: number; k: string; id: string };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function invalidCursor(): ValidationError {
  return new ValidationError({ "query.cursor": "La página pedida no es válida. Volvé a buscar desde el principio." });
}

function decodeCursor(raw: string, sort: ClientSort): Cursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  const c = value as Partial<Record<string, unknown>> | null;
  if (!c || c.s !== sort || typeof c.k !== "string" || !isTenantId(c.id)) throw invalidCursor();
  if (sort === "last_visit") {
    if (c.v !== null && (typeof c.v !== "string" || Number.isNaN(Date.parse(c.v)))) throw invalidCursor();
    return { s: "last_visit", v: c.v as string | null, k: c.k, id: c.id };
  }
  if (sort === "total_spent" || sort === "visit_count") {
    if (typeof c.n !== "number" || !Number.isSafeInteger(c.n)) throw invalidCursor();
    return { s: sort, n: c.n, k: c.k, id: c.id };
  }
  return { s: "name", k: c.k, id: c.id };
}

const numericColumn = (sort: "total_spent" | "visit_count") => (sort === "total_spent" ? clients.totalSpentCents : clients.visitCount);

/** Filas que van DESPUÉS del cursor, con el mismo orden que el ORDER BY. */
function afterCursor(cursor: Cursor): SQL {
  const byName = or(sql`${nameKey} > ${cursor.k}`, and(sql`${nameKey} = ${cursor.k}`, sql`${clients.id} > ${cursor.id}::uuid`)) as SQL;
  if (cursor.s === "name") return byName;
  if (cursor.s === "last_visit") {
    // last_visit_at DESC NULLS LAST, después nombre e id.
    if (cursor.v === null) return and(sql`${clients.lastVisitAt} IS NULL`, byName) as SQL;
    return or(
      sql`${clients.lastVisitAt} < ${cursor.v}::timestamptz`,
      sql`${clients.lastVisitAt} IS NULL`,
      and(sql`${clients.lastVisitAt} = ${cursor.v}::timestamptz`, byName),
    ) as SQL;
  }
  // Gasto o visitas DESC (NOT NULL), después nombre e id.
  const column = numericColumn(cursor.s);
  return or(sql`${column} < ${cursor.n}`, and(sql`${column} = ${cursor.n}`, byName)) as SQL;
}

function orderFor(sort: ClientSort): SQL[] {
  switch (sort) {
    case "name":
      return [asc(nameKey), asc(clients.id)];
    case "last_visit":
      return [sql`${clients.lastVisitAt} DESC NULLS LAST`, asc(nameKey), asc(clients.id)];
    case "total_spent":
    case "visit_count":
      return [sql`${numericColumn(sort)} DESC`, asc(nameKey), asc(clients.id)];
  }
}

function cursorOf(sort: ClientSort, row: { id: string; nameKey: string; lastVisitText: string | null; visitCount: number; totalSpentCents: number }): Cursor {
  switch (sort) {
    case "name":
      return { s: "name", k: row.nameKey, id: row.id };
    case "last_visit":
      return { s: "last_visit", v: row.lastVisitText, k: row.nameKey, id: row.id };
    case "total_spent":
      return { s: "total_spent", n: row.totalSpentCents, k: row.nameKey, id: row.id };
    case "visit_count":
      return { s: "visit_count", n: row.visitCount, k: row.nameKey, id: row.id };
  }
}

// ── Consultas ───────────────────────────────────────────────────────────────

/** Una página de la lista de clientes del negocio (API pública: panel y, en I6, Campañas). */
export async function listClients(
  executor: Executor,
  businessId: string,
  input: ListClientsInput = {},
  options: ListClientsOptions = {},
): Promise<ClientPage> {
  const ctx = await contextOf(executor, businessId);
  const now = options.now ?? new Date();
  const sort = input.sort ?? "name";
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const cursor = input.cursor ? decodeCursor(input.cursor, sort) : null;
  const rules = ctx.clientStatusRules;

  const where = and(
    eq(clients.businessId, businessId),
    notAnonymized,
    scopeCondition(options.scope),
    filterConditions(ctx, input, now),
    cursor ? afterCursor(cursor) : undefined,
  );

  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select({
        id: clients.id,
        name: clients.name,
        phone: clients.phone,
        email: clients.email,
        tags: clients.tags,
        visitCount: clients.visitCount,
        lastVisitAt: clients.lastVisitAt,
        totalSpentCents: clients.totalSpentCents,
        nameKey,
        lastVisitText,
        status: options.withStatus ? clientStatusSql(rules, now) : sql<ClientStatus | null>`NULL::text`,
        isVip: options.withStatus ? vipSql(rules) : sql<boolean | null>`NULL::boolean`,
      })
      .from(clients)
      .where(where)
      .orderBy(...orderFor(sort))
      .limit(limit + 1),
  );

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      tags: r.tags ?? [],
      visitCount: r.visitCount,
      lastVisitAt: r.lastVisitAt ? r.lastVisitAt.toISOString() : null,
      totalSpentCents: r.totalSpentCents,
      status: r.status ?? null,
      isVip: r.isVip ?? null,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(cursorOf(sort, last)) : null,
  };
}

/** Cantidad de clientes por estado con los filtros dados (el de estado se ignora): chips de la lista. */
export async function countClientsByStatus(
  executor: Executor,
  businessId: string,
  filters: ClientFilters = {},
  options: Pick<ListClientsOptions, "scope" | "now"> = {},
): Promise<ClientStatusCounts> {
  const ctx = await contextOf(executor, businessId);
  const now = options.now ?? new Date();
  const status = clientStatusSql(ctx.clientStatusRules, now);
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select({ status, count: sql<number>`count(*)::int` })
      .from(clients)
      .where(and(eq(clients.businessId, businessId), notAnonymized, scopeCondition(options.scope), filterConditions(ctx, { ...filters, statuses: undefined }, now)))
      .groupBy(sql`1`),
  );
  const counts = Object.fromEntries(CLIENT_STATUSES.map((s) => [s, 0])) as ClientStatusCounts;
  counts.total = 0;
  for (const r of rows) {
    const n = Number(r.count);
    if ((CLIENT_STATUSES as readonly string[]).includes(r.status)) counts[r.status] = n;
    counts.total += n;
  }
  return counts;
}

/** Etiquetas en uso en el negocio (tal como están escritas), con cuántos clientes las tienen. */
export async function listClientTags(executor: Executor, businessId: string, options: Pick<ListClientsOptions, "scope"> = {}): Promise<{ tag: string; count: number }[]> {
  const rows = await withTenant(executor, businessId, (tx) =>
    tx.execute(sql`
      SELECT t.tag AS tag, count(*)::int AS count
        FROM ${clients}, jsonb_array_elements_text(${clients.tags}) AS t(tag)
       WHERE ${and(eq(clients.businessId, businessId), notAnonymized, scopeCondition(options.scope))}
       GROUP BY t.tag
       ORDER BY count(*) DESC, lower(t.tag) ASC, t.tag ASC
       LIMIT 200`),
  );
  return rowsOf<{ tag: string; count: number | string }>(rows).map((r) => ({ tag: r.tag, count: Number(r.count) }));
}

/**
 * Recorre TODOS los clientes que cumplen los filtros, en lotes (keyset por nombre): para
 * exportar sin cargar la lista entera en memoria. Filas completas.
 */
export async function* iterateClients(
  executor: Executor,
  businessId: string,
  filters: ClientFilters = {},
  options: Pick<ListClientsOptions, "scope" | "now"> & { batchSize?: number } = {},
): AsyncGenerator<{ row: Client; status: ClientStatus; isVip: boolean }[]> {
  const ctx = await contextOf(executor, businessId);
  const now = options.now ?? new Date();
  const rules = ctx.clientStatusRules;
  const batchSize = Math.min(Math.max(options.batchSize ?? 500, 1), 2000);
  let cursor: Cursor | null = null;
  for (;;) {
    const where = and(
      eq(clients.businessId, businessId),
      notAnonymized,
      scopeCondition(options.scope),
      filterConditions(ctx, filters, now),
      cursor ? afterCursor(cursor) : undefined,
    );
    const rows = await withTenant(executor, businessId, (tx) =>
      tx
        .select({ row: clients, nameKey, status: clientStatusSql(rules, now), isVip: vipSql(rules) })
        .from(clients)
        .where(where)
        .orderBy(...orderFor("name"))
        .limit(batchSize),
    );
    if (rows.length === 0) return;
    yield rows.map((r) => ({ row: r.row, status: r.status, isVip: Boolean(r.isVip) }));
    if (rows.length < batchSize) return;
    const last = rows[rows.length - 1];
    cursor = { s: "name", k: last.nameKey, id: last.row.id };
  }
}
