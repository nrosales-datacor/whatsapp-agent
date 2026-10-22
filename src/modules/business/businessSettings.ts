import { eq } from "drizzle-orm";
import { z } from "zod";
import { recordConfigChange } from "../../platform/audit/configHistory";
import { withTenant, type Executor } from "../../platform/db/scope";
import { canManage } from "../../platform/http/access";
import { HttpError } from "../../platform/http/errors";
import type { Session } from "../../platform/http/routeTypes";
import { invalidateBusinessContext } from "./context";
import { isValidTimeZone } from "./provisioning";
import { businesses, type Business } from "./schema";
import { DEFAULT_TERMINOLOGY, REMINDER_CHANNELS, type Branding, type ReminderChannel, type Terminology } from "./settings";

// ─────────────────────────────────────────────────────────────────────────────
// Configuración > Negocio (`GET/PATCH /settings/business`): nombre, datos legales, zona
// horaria, moneda, país, terminología, canales de recordatorio y marca.
//
//   • Todos los roles leen; los datos legales y de facturación solo los ve quien edita
//     (dueño y administración).
//   • La terminología se guarda como overrides sobre DEFAULT_TERMINOLOGY: un valor vacío
//     o igual al default borra el override (así un default nuevo llega a todos).
//   • Cada cambio deja su snapshot en config_history (misma transacción) e invalida el
//     caché del contexto del negocio al confirmar (`me`, agenda y agente lo ven al toque
//     en este proceso; en los demás, al vencer el TTL).
//   • La marca propia es del plan Pro (PLAN-GESTION.md §5, "Crecimiento"): la ruta pregunta
//     al plan (`PlanHooks.hasFeature`, lo inyecta la composición desde modules/billing) y
//     pasa la respuesta; sin ella, el PATCH con `branding` responde 403 `module_not_in_plan`.
//     La marca guardada se conserva (vuelve si el negocio pasa a Pro).
// ─────────────────────────────────────────────────────────────────────────────

export interface BusinessLegalInfo {
  legalName: string | null;
  taxId: string | null;
  billingEmail: string | null;
}

export interface BusinessSettings {
  id: string;
  slug: string;
  name: string;
  industry: string;
  plan: string;
  status: string;
  timezone: string;
  /** ISO 4217: los montos del negocio son céntimos de esta moneda. */
  currency: string;
  country: string;
  /** Terminología completa (overrides del negocio sobre los defaults). */
  terminology: Terminology;
  /** Canales activos de recordatorio, en orden de preferencia (vacío = no manda). */
  reminderChannels: ReminderChannel[];
  branding: Branding;
  /** ¿El plan incluye la marca propia? (Pro). */
  brandingEditable: boolean;
  /** Datos legales y de facturación; null para quien no edita la configuración. */
  legal: BusinessLegalInfo | null;
  updatedAt: string;
}

function terminologyOf(business: Business): Terminology {
  const merged = { ...DEFAULT_TERMINOLOGY };
  for (const key of Object.keys(merged) as (keyof Terminology)[]) {
    const value = business.terminology[key];
    if (typeof value === "string" && value.trim()) merged[key] = value;
  }
  return merged;
}

function toSettings(business: Business, withLegal: boolean, brandingEditable: boolean): BusinessSettings {
  return {
    id: business.id,
    slug: business.slug,
    name: business.name,
    industry: business.industry,
    plan: business.plan,
    status: business.status,
    timezone: business.timezone,
    currency: business.currency,
    country: business.country,
    terminology: terminologyOf(business),
    reminderChannels: business.reminderChannels.filter((c): c is ReminderChannel => (REMINDER_CHANNELS as readonly string[]).includes(c)),
    branding: { ...business.branding },
    brandingEditable,
    legal: withLegal ? { legalName: business.legalName, taxId: business.taxId, billingEmail: business.billingEmail } : null,
    updatedAt: business.updatedAt.toISOString(),
  };
}

/** Lo que guarda config_history de un cambio del negocio (sin datos de facturación sensibles de más). */
function snapshotOf(business: Business): Record<string, unknown> {
  return {
    name: business.name,
    timezone: business.timezone,
    currency: business.currency,
    country: business.country,
    terminology: business.terminology,
    reminderChannels: business.reminderChannels,
    branding: business.branding,
    legalName: business.legalName,
    taxId: business.taxId,
    billingEmail: business.billingEmail,
  };
}

// ── Validación ──────────────────────────────────────────────────────────────

/** Texto opcional: recorta, y vacío = null (borrar el dato). */
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((s) => (s ? s : null));

const Term = z
  .string()
  .trim()
  .max(40)
  .transform((s) => s.toLocaleLowerCase("es"));

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color inválido (formato #rrggbb).");

const TERMINOLOGY_KEYS = Object.keys(DEFAULT_TERMINOLOGY) as [keyof Terminology, ...(keyof Terminology)[]];

export const BusinessSettingsPatch = z
  .object({
    name: z.string().trim().min(1).max(120),
    legalName: OptionalText(200),
    taxId: OptionalText(40),
    billingEmail: z
      .union([z.literal(""), z.email().max(320)])
      .nullable()
      .transform((s) => (s ? s.toLowerCase() : null)),
    timezone: z.string().trim().refine(isValidTimeZone, "Zona horaria inválida (ej. America/Costa_Rica)."),
    currency: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{3}$/, "Moneda inválida (código ISO de 3 letras, ej. CRC).")),
    country: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{2}$/, "País inválido (código ISO de 2 letras, ej. CR).")),
    // Vacío = volver al default.
    terminology: z.partialRecord(z.enum(TERMINOLOGY_KEYS), Term),
    reminderChannels: z
      .array(z.enum(REMINDER_CHANNELS))
      .max(REMINDER_CHANNELS.length)
      .refine((list) => new Set(list).size === list.length, "Cada canal va una sola vez."),
    // null = quitar ese dato de la marca.
    branding: z
      .object({
        accentColor: HexColor.nullable(),
        headerColor: HexColor.nullable(),
        logoUrl: z
          .url({ protocol: /^https$/, error: "El logo tiene que ser una URL https." })
          .max(500)
          .nullable(),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "Indicá qué cambiar." });

export type BusinessSettingsPatchInput = z.output<typeof BusinessSettingsPatch>;

// ── Lectura y escritura ─────────────────────────────────────────────────────

const notFound = () => new HttpError(404, "Negocio no encontrado.", "not_found");

export async function getBusinessSettings(db: Executor, session: Session, brandingEditable: boolean): Promise<BusinessSettings> {
  const [business] = await withTenant(db, session.businessId, (tx) =>
    tx.select().from(businesses).where(eq(businesses.id, session.businessId)).limit(1),
  );
  if (!business) throw notFound();
  return toSettings(business, canManage(session.role), brandingEditable);
}

function mergeTerminology(current: Partial<Terminology>, patch: Partial<Record<keyof Terminology, string>>): Partial<Terminology> {
  const next: Partial<Terminology> = { ...current };
  for (const [key, value] of Object.entries(patch) as [keyof Terminology, string][]) {
    if (!value || value === DEFAULT_TERMINOLOGY[key]) delete next[key];
    else next[key] = value;
  }
  return next;
}

function mergeBranding(current: Branding, patch: Partial<Record<keyof Branding, string | null>>): Branding {
  const next: Branding = { ...current };
  for (const [key, value] of Object.entries(patch) as [keyof Branding, string | null][]) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

export async function updateBusinessSettings(
  db: Executor,
  session: Session,
  patch: BusinessSettingsPatchInput,
  brandingEditable: boolean,
): Promise<BusinessSettings> {
  const { businessId } = session;
  if (patch.branding && !brandingEditable) {
    throw new HttpError(403, "La marca propia es parte del plan Pro.", "module_not_in_plan");
  }
  const updated = await withTenant(db, businessId, async (tx) => {
    const [current] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).for("update");
    if (!current) throw notFound();
    const changes: Partial<typeof businesses.$inferInsert> = {};
    if (patch.name !== undefined) changes.name = patch.name;
    if (patch.legalName !== undefined) changes.legalName = patch.legalName;
    if (patch.taxId !== undefined) changes.taxId = patch.taxId;
    if (patch.billingEmail !== undefined) changes.billingEmail = patch.billingEmail;
    if (patch.timezone !== undefined) changes.timezone = patch.timezone;
    if (patch.currency !== undefined) changes.currency = patch.currency;
    if (patch.country !== undefined) changes.country = patch.country;
    if (patch.terminology !== undefined) changes.terminology = mergeTerminology(current.terminology, patch.terminology);
    if (patch.reminderChannels !== undefined) changes.reminderChannels = [...patch.reminderChannels];
    if (patch.branding !== undefined) changes.branding = mergeBranding(current.branding, patch.branding);

    const [row] = await tx.update(businesses).set(changes).where(eq(businesses.id, businessId)).returning();
    await recordConfigChange(tx, { businessId, entity: "business", entityId: businessId, snapshot: snapshotOf(row), changedBy: session.userId });
    return row;
  });
  invalidateBusinessContext(businessId);
  return toSettings(updated, canManage(session.role), brandingEditable);
}
