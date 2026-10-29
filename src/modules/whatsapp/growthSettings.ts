import { eq } from "drizzle-orm";
import { z } from "zod";
import { recordConfigChange } from "../../platform/audit/configHistory";
import { withTenant, type Executor } from "../../platform/db/scope";
import { HttpError, ValidationError } from "../../platform/http/errors";
import { getServices } from "../catalog";
import { listChannelRows } from "./channels";
import type { GrowthFeatures } from "./growth";
import { getAiSettings, type AiSettingsActor } from "./settings";
import { aiSettings, type AiSettings, type UpsellRule } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Configuración de crecimiento del agente (I6): reseñas (seguimiento post-servicio),
// rescate de cotizaciones y upsell. Vive en `ai_settings` (columnas `follow_up`,
// `review_url`, `quote_recovery` y `upsell`), aparte de la configuración del bot: el plan
// dice si cada función se PUEDE usar (`allowed`, inyectado desde billing) y el dueño
// decide si la USA. Guardar una función que el plan no trae responde 403
// `module_not_in_plan`; lo ya guardado se conserva (si el plan la vuelve a traer, sigue
// como estaba) pero los barridos y el agente no la usan.
//
//   GET   /whatsapp/growth   cualquier rol con el módulo
//   PATCH /whatsapp/growth   dueño, admin (cada sección se reemplaza entera)
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_FOLLOW_UP_DELAY_HOURS = 3;
export const DEFAULT_QUOTE_WAIT_HOURS = 3;
export const MAX_UPSELL_RULES = 30;
const MIN_HOURS = 1;
const MAX_HOURS = 72;

/** Configuración efectiva (sin mirar el plan): la leen los barridos y el agente. */
export interface GrowthConfig {
  reviews: { enabled: boolean; delayHours: number; reviewUrl: string | null };
  quoteRecovery: { enabled: boolean; waitHours: number; firstTouchText: string | null };
  upsell: { enabled: boolean; rules: UpsellRule[] };
}

/** Lo que ve el panel. */
export interface GrowthSettingsView extends GrowthConfig {
  /** Lo que el plan permite (el resto se muestra con candado). */
  allowed: Pick<GrowthFeatures, "reviews" | "quoteRecovery" | "upsell">;
  /** Plantillas cargadas en algún número activo (fuera de la ventana de 24 h son obligatorias). */
  templates: { followUp: boolean; quoteRecovery: boolean };
}

const clampHours = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(MAX_HOURS, Math.max(MIN_HOURS, Math.round(value))) : fallback;

const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function rulesOf(raw: unknown): UpsellRule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is UpsellRule => !!r && typeof r.serviceId === "string" && typeof r.suggestServiceId === "string")
    .map((r) => ({ serviceId: r.serviceId, suggestServiceId: r.suggestServiceId }));
}

/** Lee la configuración de una fila de `ai_settings` (tolerante: lo inválido cae al default). */
export function growthConfigOf(row: Pick<AiSettings, "followUp" | "reviewUrl" | "quoteRecovery" | "upsell"> | null | undefined): GrowthConfig {
  return {
    reviews: {
      enabled: row?.followUp?.enabled === true,
      delayHours: clampHours(row?.followUp?.delayHours, DEFAULT_FOLLOW_UP_DELAY_HOURS),
      reviewUrl: nonEmpty(row?.reviewUrl),
    },
    quoteRecovery: {
      enabled: row?.quoteRecovery?.enabled === true,
      waitHours: clampHours(row?.quoteRecovery?.waitHours, DEFAULT_QUOTE_WAIT_HOURS),
      firstTouchText: nonEmpty(row?.quoteRecovery?.firstTouchText),
    },
    upsell: { enabled: row?.upsell?.enabled === true, rules: rulesOf(row?.upsell?.rules) },
  };
}

/** Configuración de crecimiento del negocio (sin la fila todavía: todo apagado). */
export async function readGrowthConfig(executor: Executor, businessId: string): Promise<GrowthConfig> {
  const [row] = await withTenant(executor, businessId, (tx) =>
    tx
      .select({ followUp: aiSettings.followUp, reviewUrl: aiSettings.reviewUrl, quoteRecovery: aiSettings.quoteRecovery, upsell: aiSettings.upsell })
      .from(aiSettings)
      .where(eq(aiSettings.businessId, businessId))
      .limit(1),
  );
  return growthConfigOf(row);
}

async function templatesOf(executor: Executor, businessId: string): Promise<GrowthSettingsView["templates"]> {
  const active = (await listChannelRows(executor, businessId)).filter((r) => r.status === "active");
  return { followUp: active.some((r) => r.templates?.followUp), quoteRecovery: active.some((r) => r.templates?.quoteRecovery) };
}

export async function getGrowthSettings(executor: Executor, businessId: string, allowed: GrowthFeatures): Promise<GrowthSettingsView> {
  // La primera lectura crea la fila de `ai_settings` (con los defaults del rubro).
  await getAiSettings(executor, businessId);
  const [config, templates] = await Promise.all([readGrowthConfig(executor, businessId), templatesOf(executor, businessId)]);
  return { ...config, allowed: { reviews: allowed.reviews, quoteRecovery: allowed.quoteRecovery, upsell: allowed.upsell }, templates };
}

// ── Escritura ───────────────────────────────────────────────────────────────

const Hours = z.number().int().min(MIN_HOURS, `Mínimo ${MIN_HOURS} hora.`).max(MAX_HOURS, `Máximo ${MAX_HOURS} horas.`);

/** Link para dejar una reseña (Google "Escribir reseña", g.page…): solo https. */
const ReviewUrl = z
  .string()
  .trim()
  .max(500)
  .nullable()
  .transform((s) => (s ? s : null))
  .refine((s) => {
    if (s === null) return true;
    try {
      return new URL(s).protocol === "https:";
    } catch {
      return false;
    }
  }, "Pegá el link completo de tu página de reseñas (empieza con https://).");

const Uuid = z.uuid("Servicio inválido.");

export const GrowthSettingsPatch = z
  .object({
    reviews: z.object({ enabled: z.boolean(), delayHours: Hours, reviewUrl: ReviewUrl }).strict(),
    quoteRecovery: z
      .object({
        enabled: z.boolean(),
        waitHours: Hours,
        // Texto propio del primer toque; vacío = el de catálogo. Variables: {servicio} {monto}.
        firstTouchText: z
          .string()
          .trim()
          .max(500)
          .nullable()
          .transform((s) => (s ? s : null)),
      })
      .strict(),
    upsell: z
      .object({
        enabled: z.boolean(),
        rules: z
          .array(z.object({ serviceId: Uuid, suggestServiceId: Uuid }).strict())
          .max(MAX_UPSELL_RULES, `Como máximo ${MAX_UPSELL_RULES} reglas.`),
      })
      .strict(),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "Indicá qué cambiar." });

export type GrowthSettingsPatchInput = z.output<typeof GrowthSettingsPatch>;

function notInPlan(): HttpError {
  return new HttpError(403, "Esta función es del plan Pro. Para usarla, ampliá tu plan en Configuración › Plan.", "module_not_in_plan");
}

/** Reglas válidas: servicios activos del negocio, distintos entre sí y sin repetir el que se agenda. */
async function validateRules(executor: Executor, businessId: string, rules: UpsellRule[]): Promise<UpsellRule[]> {
  const active = new Set((await getServices(executor, businessId, { activeOnly: true })).map((s) => s.id));
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  const out: UpsellRule[] = [];
  rules.forEach((rule, i) => {
    const serviceId = rule.serviceId.toLowerCase();
    const suggestServiceId = rule.suggestServiceId.toLowerCase();
    if (!active.has(serviceId)) errors[`upsell.rules.${i}.serviceId`] = "Ese servicio no existe o no está activo.";
    else if (!active.has(suggestServiceId)) errors[`upsell.rules.${i}.suggestServiceId`] = "Ese servicio no existe o no está activo.";
    else if (serviceId === suggestServiceId) errors[`upsell.rules.${i}.suggestServiceId`] = "Elegí un servicio distinto al que se agenda.";
    else if (seen.has(`${serviceId}>${suggestServiceId}`)) errors[`upsell.rules.${i}.suggestServiceId`] = "Esa regla está repetida.";
    seen.add(`${serviceId}>${suggestServiceId}`);
    out.push({ serviceId, suggestServiceId });
  });
  if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  return out;
}

/** Cambia la configuración de crecimiento (los permisos de rol los aplica la ruta). */
export async function updateGrowthSettings(
  executor: Executor,
  actor: AiSettingsActor,
  allowed: GrowthFeatures,
  patch: GrowthSettingsPatchInput,
): Promise<GrowthSettingsView> {
  const { businessId } = actor;
  if (patch.reviews && !allowed.reviews) throw notInPlan();
  if (patch.quoteRecovery && !allowed.quoteRecovery) throw notInPlan();
  if (patch.upsell && !allowed.upsell) throw notInPlan();
  // Reseñas sin link: se pide la opinión igual (el "Mal" avisa al equipo), pero no la reseña.
  const rules = patch.upsell ? await validateRules(executor, businessId, patch.upsell.rules) : null;
  await getAiSettings(executor, businessId);
  await withTenant(executor, businessId, async (tx) => {
    await tx.select({ id: aiSettings.businessId }).from(aiSettings).where(eq(aiSettings.businessId, businessId)).for("update");
    const changes: Partial<typeof aiSettings.$inferInsert> = {};
    if (patch.reviews) {
      changes.followUp = { enabled: patch.reviews.enabled, delayHours: patch.reviews.delayHours };
      changes.reviewUrl = patch.reviews.reviewUrl;
    }
    if (patch.quoteRecovery) {
      changes.quoteRecovery = {
        enabled: patch.quoteRecovery.enabled,
        waitHours: patch.quoteRecovery.waitHours,
        ...(patch.quoteRecovery.firstTouchText ? { firstTouchText: patch.quoteRecovery.firstTouchText } : {}),
      };
    }
    if (patch.upsell && rules) changes.upsell = { enabled: patch.upsell.enabled, rules };
    const [updated] = await tx.update(aiSettings).set(changes).where(eq(aiSettings.businessId, businessId)).returning();
    await recordConfigChange(tx, { businessId, entity: "ai_growth", entityId: null, snapshot: growthConfigOf(updated), changedBy: actor.userId });
  });
  return getGrowthSettings(executor, businessId, allowed);
}
