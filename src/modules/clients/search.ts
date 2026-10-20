import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";
import { isTenantId, withTenant, type Executor } from "../../platform/db/scope";
import { ValidationError } from "../../platform/http/errors";
import { phoneDigits } from "./phone";
import { clients } from "./schema";
import { notAnonymized } from "./service";

// ─────────────────────────────────────────────────────────────────────────────
// Lista y búsqueda de clientes del panel (`GET /clients`): por nombre, teléfono o correo,
// ordenada por nombre o por última visita, con paginación por cursor (keyset: estable
// aunque entren clientes nuevos mientras se pagina, y sin OFFSET que se ponga lento).
//
// Nombre sin tildes ni mayúsculas ("maria" encuentra a "María") con `translate` + `lower`
// (sin extensiones: PGlite y Supabase igual). La misma expresión ordena la lista, así
// "Ángela" queda con las A y no después de la Z. Los clientes con los datos eliminados no
// aparecen (su fila queda solo para el historial de citas y pagos).
// ─────────────────────────────────────────────────────────────────────────────

export const CLIENT_SORTS = ["name", "last_visit"] as const;
export type ClientSort = (typeof CLIENT_SORTS)[number];

export interface ListClientsInput {
  /** Texto libre: palabras del nombre, parte del correo o dígitos del teléfono. */
  q?: string;
  sort?: ClientSort;
  /** `nextCursor` de la página anterior. */
  cursor?: string;
  /** Default 50, máximo 100. */
  limit?: number;
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
}

export interface ClientPage {
  items: ClientSummary[];
  /** Cursor de la página siguiente, o null si no hay más. */
  nextCursor: string | null;
}

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

// ── Cursor ──────────────────────────────────────────────────────────────────

type Cursor = { s: "name"; k: string; id: string } | { s: "last_visit"; v: string | null; k: string; id: string };

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
  return { s: "name", k: c.k, id: c.id };
}

/** Filas que van DESPUÉS del cursor, con el mismo orden que el ORDER BY. */
function afterCursor(cursor: Cursor): SQL {
  const byName = or(sql`${nameKey} > ${cursor.k}`, and(sql`${nameKey} = ${cursor.k}`, sql`${clients.id} > ${cursor.id}::uuid`)) as SQL;
  if (cursor.s === "name") return byName;
  // last_visit_at DESC NULLS LAST, después nombre e id.
  if (cursor.v === null) return and(sql`${clients.lastVisitAt} IS NULL`, byName) as SQL;
  return or(
    sql`${clients.lastVisitAt} < ${cursor.v}::timestamptz`,
    sql`${clients.lastVisitAt} IS NULL`,
    and(sql`${clients.lastVisitAt} = ${cursor.v}::timestamptz`, byName),
  ) as SQL;
}

// ── Consulta ────────────────────────────────────────────────────────────────

/** Una página de la lista de clientes del negocio. */
export async function listClients(executor: Executor, businessId: string, input: ListClientsInput = {}): Promise<ClientPage> {
  const sort = input.sort ?? "name";
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const cursor = input.cursor ? decodeCursor(input.cursor, sort) : null;

  const where = and(eq(clients.businessId, businessId), notAnonymized, searchCondition(input.q), cursor ? afterCursor(cursor) : undefined);
  const order =
    sort === "name"
      ? [asc(nameKey), asc(clients.id)]
      : [sql`${clients.lastVisitAt} DESC NULLS LAST`, asc(nameKey), asc(clients.id)];

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
        nameKey,
        lastVisitText,
      })
      .from(clients)
      .where(where)
      .orderBy(...order)
      .limit(limit + 1),
  );

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor(
          sort === "name"
            ? { s: "name", k: last.nameKey, id: last.id }
            : { s: "last_visit", v: last.lastVisitText, k: last.nameKey, id: last.id },
        )
      : null;

  return {
    items: page.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      tags: r.tags ?? [],
      visitCount: r.visitCount,
      lastVisitAt: r.lastVisitAt ? r.lastVisitAt.toISOString() : null,
    })),
    nextCursor,
  };
}

