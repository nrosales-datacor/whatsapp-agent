import { desc, eq, like, or, sql } from "drizzle-orm";
import { withSystem, withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { businesses, customFields, locationHours, locations, type BillingStatus, type Business, type Location, type Plan } from "./schema";
import { loadIndustryTemplate, type Industry, type TemplateCatalog } from "./templates";
import type { ExtraModules } from "./settings";

// ─────────────────────────────────────────────────────────────────────────────
// Alta y listado de negocios (lo usa el superadmin, src/admin). Es cross-tenant por
// diseño: corre con `withSystem`. Si el llamador ya abrió una transacción (p. ej. el alta
// junto con la invitación al dueño), le pasa esa transacción y todo queda atómico.
//
// El alta aplica la plantilla del rubro (`applyIndustryTemplate`, ver ./templates.ts): lo
// que es de business (terminología, reglas de estado de cliente, campos personalizados)
// lo escribe acá; el catálogo lo escribe modules/catalog a través de `ProvisioningSteps`
// (business no puede importar catalog: catalog depende de business). Igual los métodos de
// pago de modules/sales (`seedPaymentMethods`). La sección `ai` la aplica el módulo
// whatsapp en I2.
// ─────────────────────────────────────────────────────────────────────────────

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
  /** Plan con el que nace (default: el de la tabla, `basic`). */
  plan?: Plan;
  /** Estado del cobro con el que nace (default: `trial`). */
  billingStatus?: BillingStatus;
  /** Fin de la prueba gratis (alta self-service); sin valor = sin fecha (cobro manual). */
  trialEndsAt?: Date | null;
}

export interface CreatedBusiness {
  business: Business;
  location: Location;
}

/**
 * Pasos del alta que viven en otros módulos y se inyectan (los arma quien compone:
 * src/admin/routes.ts, scripts/seedDev.ts).
 */
export interface ProvisioningSteps {
  /** Carga las categorías y servicios de la plantilla (`applyCatalogTemplate` de modules/catalog). */
  seedCatalog: (tx: Tx, input: { businessId: string; catalog: TemplateCatalog }) => Promise<unknown>;
  /**
   * Carga los métodos de pago default (`seedDefaultPaymentMethods` de modules/sales). El
   * alta real siempre lo pasa (src/provisioning.ts); sin él, el negocio nace sin métodos.
   */
  seedPaymentMethods?: (tx: Tx, input: { businessId: string }) => Promise<unknown>;
}

/**
 * Aplica la plantilla del rubro a un negocio recién creado: terminología y reglas de
 * estado de cliente (overrides en `businesses`), campos personalizados y, vía `steps`, el
 * catálogo de ejemplo. Pensado para un negocio vacío: no borra lo que ya hubiera.
 * Devuelve el negocio como quedó.
 */
export async function applyIndustryTemplate(
  executor: Executor,
  input: { businessId: string; industry: Industry },
  steps: ProvisioningSteps,
): Promise<Business> {
  const template = loadIndustryTemplate(input.industry);
  return withTenant(executor, input.businessId, async (tx) => {
    const [business] = await tx
      .update(businesses)
      .set({ terminology: { ...template.terminology }, clientStatusRules: { ...template.clientStatusRules } })
      .where(eq(businesses.id, input.businessId))
      .returning();
    if (!business) throw new Error("applyIndustryTemplate: el negocio no existe");
    if (template.customFields.length > 0) {
      await tx.insert(customFields).values(
        template.customFields.map((f, position) => ({
          businessId: input.businessId,
          entity: f.entity,
          key: f.key,
          label: f.label,
          type: f.type,
          options: [...f.options],
          required: f.required,
          position,
        })),
      );
    }
    await steps.seedCatalog(tx, { businessId: input.businessId, catalog: template.catalog });
    return business;
  });
}

/**
 * Crea el negocio con su primera sucursal, el horario default (`DEFAULT_LOCATION_HOURS`),
 * la plantilla de su rubro (`applyIndustryTemplate`) y los métodos de pago default. El slug sale del nombre; si ya
 * existe, se le suma `-2`, `-3`…
 */
export async function createBusiness(executor: Executor, input: NewBusinessInput, steps: ProvisioningSteps): Promise<CreatedBusiness> {
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
        ...(input.plan ? { plan: input.plan } : {}),
        ...(input.billingStatus ? { billingStatus: input.billingStatus } : {}),
        trialEndsAt: input.trialEndsAt ?? null,
      })
      .returning();
    const [location] = await tx
      .insert(locations)
      .values({ businessId: business.id, name: input.locationName, timezone: input.timezone, position: 0 })
      .returning();
    await tx
      .insert(locationHours)
      .values(DEFAULT_LOCATION_HOURS.map((h) => ({ businessId: business.id, locationId: location.id, ...h })));
    const withTemplate = await applyIndustryTemplate(tx, { businessId: business.id, industry: input.industry }, steps);
    if (steps.seedPaymentMethods) await steps.seedPaymentMethods(tx, { businessId: business.id });
    return { business: withTemplate, location };
  });
}

export interface BusinessSummary {
  id: string;
  name: string;
  slug: string;
  industry: string;
  plan: string;
  /** Lo contratado encima del plan (módulos sueltos y cupos); lo interpreta billing. */
  extraModules: ExtraModules;
  status: string;
  /** Estado del cobro manual (trial, active, past_due, cancelled). */
  billingStatus: string;
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
        extraModules: businesses.extraModules,
        status: businesses.status,
        billingStatus: businesses.billingStatus,
        currency: businesses.currency,
        country: businesses.country,
        timezone: businesses.timezone,
        createdAt: businesses.createdAt,
        // Nombres calificados a mano: dentro del subquery, drizzle deja las columnas sin
        // tabla y `id` se resolvería a `locations.id` (contaba siempre 0).
        locationCount: sql<number>`(SELECT count(*)::int FROM "locations" l WHERE l.business_id = "businesses"."id")`,
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
    extraModules: business.extraModules,
    status: business.status,
    billingStatus: business.billingStatus,
    currency: business.currency,
    country: business.country,
    timezone: business.timezone,
    locationCount,
    createdAt: business.createdAt.toISOString(),
  };
}
