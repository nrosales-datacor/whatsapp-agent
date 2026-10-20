import { desc, eq, like, or, sql } from "drizzle-orm";
import { withSystem, type Executor } from "../../platform/db/scope";
import { businesses, locationHours, locations, type Business, type Location } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Alta y listado de negocios (lo usa el superadmin, src/admin). Es cross-tenant por
// diseño: corre con `withSystem`. Si el llamador ya abrió una transacción (p. ej. el alta
// junto con la invitación al dueño), le pasa esa transacción y todo queda atómico.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rubros con plantilla (PLAN-GESTION.md §3). La columna `industry` no tiene CHECK a
 * propósito: sumar un rubro es sumar su plantilla y su nombre acá, sin migración.
 */
export const INDUSTRIES = ["generic", "dental", "aesthetics", "nails"] as const;
export type Industry = (typeof INDUSTRIES)[number];

/** Horario con el que nace la primera sucursal: lunes a viernes 8–18 y sábado 8–12 (0 = domingo). */
export const DEFAULT_LOCATION_HOURS: ReadonlyArray<{ weekday: number; opensAt: string; closesAt: string }> = [
  ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensAt: "08:00", closesAt: "18:00" })),
  { weekday: 6, opensAt: "08:00", closesAt: "12:00" },
];

/** ¿Es una zona horaria IANA que entiende el runtime ("America/Costa_Rica")? */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("es-CR", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const MAX_SLUG_LENGTH = 48;

/** "Clínica Dental Sonrisa S.A." → "clinica-dental-sonrisa-s-a" (lo que acepta el CHECK de `slug`). */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || "negocio";
}

export interface NewBusinessInput {
  name: string;
  industry: Industry;
  /** Zona IANA del negocio y de su primera sucursal. */
  timezone: string;
  /** ISO 4217 en mayúsculas ("CRC"). */
  currency: string;
  /** ISO 3166-1 alfa-2 en mayúsculas ("CR"). */
  country: string;
  locationName: string;
}

export interface CreatedBusiness {
  business: Business;
  location: Location;
}

/**
 * Crea el negocio con su primera sucursal y el horario default (`DEFAULT_LOCATION_HOURS`).
 * El slug sale del nombre; si ya existe, se le suma `-2`, `-3`…
 */
export async function createBusiness(executor: Executor, input: NewBusinessInput): Promise<CreatedBusiness> {
  if (!isValidTimeZone(input.timezone)) throw new Error("createBusiness: zona horaria inválida");
  return withSystem(executor, async (tx) => {
    const base = slugify(input.name);
    const taken = new Set(
      (
        await tx
          .select({ slug: businesses.slug })
          .from(businesses)
          .where(or(eq(businesses.slug, base), like(businesses.slug, `${base}-%`)))
      ).map((r) => r.slug),
    );
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;

    const [business] = await tx
      .insert(businesses)
      .values({
        slug,
        name: input.name,
        industry: input.industry,
        currency: input.currency,
        country: input.country,
        timezone: input.timezone,
      })
      .returning();
    const [location] = await tx
      .insert(locations)
      .values({ businessId: business.id, name: input.locationName, timezone: input.timezone, position: 0 })
      .returning();
    await tx
      .insert(locationHours)
      .values(DEFAULT_LOCATION_HOURS.map((h) => ({ businessId: business.id, locationId: location.id, ...h })));
    return { business, location };
  });
}

export interface BusinessSummary {
  id: string;
  name: string;
  slug: string;
  industry: string;
  plan: string;
  status: string;
  currency: string;
  country: string;
  timezone: string;
  locationCount: number;
  createdAt: string;
}

/** Todos los negocios, los más nuevos primero (vista del superadmin). */
export async function listBusinesses(executor: Executor): Promise<BusinessSummary[]> {
  const rows = await withSystem(executor, (tx) =>
    tx
      .select({
        id: businesses.id,
        name: businesses.name,
        slug: businesses.slug,
        industry: businesses.industry,
        plan: businesses.plan,
        status: businesses.status,
        currency: businesses.currency,
        country: businesses.country,
        timezone: businesses.timezone,
        createdAt: businesses.createdAt,
        locationCount: sql<number>`(SELECT count(*)::int FROM ${locations} WHERE ${locations.businessId} = ${businesses.id})`,
      })
      .from(businesses)
      .orderBy(desc(businesses.createdAt)),
  );
  return rows.map((r) => ({ ...r, locationCount: Number(r.locationCount), createdAt: r.createdAt.toISOString() }));
}

/** Resumen de un negocio recién creado (misma forma que `listBusinesses`). */
export function summarizeBusiness(business: Business, locationCount: number): BusinessSummary {
  return {
    id: business.id,
    name: business.name,
    slug: business.slug,
    industry: business.industry,
    plan: business.plan,
    status: business.status,
    currency: business.currency,
    country: business.country,
    timezone: business.timezone,
    locationCount,
    createdAt: business.createdAt.toISOString(),
  };
}
