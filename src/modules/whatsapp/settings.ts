import { eq } from "drizzle-orm";
import { z } from "zod";
import { recordConfigChange } from "../../platform/audit/configHistory";
import { withTenant, type Executor, type Tx } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import type { Session } from "../../platform/http/routeTypes";
import { getBusinessContext, isIndustry, loadIndustryTemplate, slugify } from "../business";
import { AI_REGISTERS, aiSettings, type AiRegister, type AiSettings, type FaqEntry, type KnowledgeBase, type KnowledgeSection } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Configuración del agente IA (`ai_settings`, una fila por negocio): tono, registro
// (vos / tú / usted), instrucciones propias, base de conocimiento por secciones, preguntas
// frecuentes y overrides de los textos fijos al cliente.
//
//   • Defaults de la plantilla de rubro: la fila nace la primera vez que alguien la lee
//     (panel o agente), con el registro y las instrucciones de la sección `ai` de la
//     plantilla del rubro del negocio (`businesses.industry`). Creación perezosa e
//     idempotente (INSERT … ON CONFLICT DO NOTHING): dos lecturas a la vez terminan en la
//     MISMA fila.
//   • Panel: `GET/PATCH /whatsapp/settings` (./settingsRoutes.ts). Lee cualquier rol con
//     el módulo; edita dueño y administración. Las listas (conocimiento, FAQ, textos) se
//     REEMPLAZAN enteras: el panel manda lo que quiere que quede.
//   • Cada cambio deja su snapshot en config_history (misma transacción).
//
// Base de conocimiento: en la base es `{ sections, facts?, policies? }` (facts/policies
// vienen del esquema viejo); la API la expone como una lista de secciones y, si hay
// facts/policies sueltos, los muestra como dos secciones más. Al guardar queda solo
// `sections`.
// ─────────────────────────────────────────────────────────────────────────────

/** Tono cuando el negocio no eligió uno. */
export const DEFAULT_TONE = "cálido, cordial y breve";

/** Topes (todo esto va al prompt en cada turno: cuesta tokens). */
export const MAX_TONE_LENGTH = 200;
export const MAX_INSTRUCTIONS_LENGTH = 4000;
export const MAX_KNOWLEDGE_CHARS = 12_000;
export const MAX_FAQ_CHARS = 12_000;
export const MAX_TEXT_OVERRIDE_LENGTH = 1000;
export const MAX_TEXT_OVERRIDES = 50;

/** Configuración del agente tal como la ven el panel y el agente. */
export interface AiSettingsView {
  tone: string;
  register: AiRegister;
  instructions: string;
  knowledge: KnowledgeSection[];
  faq: FaqEntry[];
  /** Override de los textos fijos al cliente: clave del catálogo → plantilla. */
  texts: Record<string, string>;
}

/** Quién cambia la configuración (una sesión del panel, o el sistema con `userId: null`). */
export type AiSettingsActor = Pick<Session, "businessId"> & { userId: string | null };

const notFound = () => new HttpError(404, "Negocio no encontrado.", "not_found");

export function isAiRegister(value: unknown): value is AiRegister {
  return typeof value === "string" && (AI_REGISTERS as readonly string[]).includes(value);
}

interface TemplateDefaults {
  register: AiRegister;
  instructions: string;
}

/** Defaults de la sección `ai` de la plantilla del rubro (rubro desconocido → genérico). */
export function aiDefaultsForIndustry(industry: string): TemplateDefaults {
  const template = loadIndustryTemplate(isIndustry(industry) ? industry : "generic");
  return { register: template.ai.register, instructions: template.ai.instructions };
}

// ── Lectura ─────────────────────────────────────────────────────────────────

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function knowledgeOf(kb: KnowledgeBase | null | undefined): KnowledgeSection[] {
  const sections = (Array.isArray(kb?.sections) ? kb.sections : [])
    .filter((s): s is KnowledgeSection => !!s && isNonEmptyString(s.title) && Array.isArray(s.items))
    .map((s) => ({ id: isNonEmptyString(s.id) ? s.id : slugify(s.title), title: s.title, items: s.items.filter(isNonEmptyString) }));
  const facts = Array.isArray(kb?.facts) ? kb.facts.filter(isNonEmptyString) : [];
  const policies = Array.isArray(kb?.policies) ? kb.policies.filter(isNonEmptyString) : [];
  if (facts.length) sections.push({ id: "facts", title: "Datos útiles", items: facts });
  if (policies.length) sections.push({ id: "policies", title: "Políticas", items: policies });
  return sections;
}

function faqOf(faq: unknown): FaqEntry[] {
  if (!Array.isArray(faq)) return [];
  return faq
    .filter((f): f is FaqEntry => !!f && isNonEmptyString((f as FaqEntry).question) && isNonEmptyString((f as FaqEntry).answer))
    .map((f) => ({ question: f.question, answer: f.answer }));
}

function textsOf(texts: unknown): Record<string, string> {
  if (!texts || typeof texts !== "object" || Array.isArray(texts)) return {};
  return Object.fromEntries(Object.entries(texts as Record<string, unknown>).filter((e): e is [string, string] => isNonEmptyString(e[1])));
}

function toView(row: AiSettings, defaults: TemplateDefaults): AiSettingsView {
  return {
    tone: row.tone?.trim() || DEFAULT_TONE,
    register: isAiRegister(row.register) ? row.register : defaults.register,
    instructions: row.instructions ?? "",
    knowledge: knowledgeOf(row.knowledge),
    faq: faqOf(row.faq),
    texts: textsOf(row.texts),
  };
}

/** La fila del negocio; si no existe, la crea con los defaults de la plantilla (idempotente). */
async function ensureRow(tx: Tx, businessId: string, defaults: TemplateDefaults): Promise<AiSettings> {
  const [inserted] = await tx
    .insert(aiSettings)
    .values({ businessId, tone: DEFAULT_TONE, register: defaults.register, instructions: defaults.instructions })
    .onConflictDoNothing({ target: aiSettings.businessId })
    .returning();
  if (inserted) return inserted;
  const [row] = await tx.select().from(aiSettings).where(eq(aiSettings.businessId, businessId)).limit(1);
  if (!row) throw new Error("ai_settings: no se pudo crear ni leer la fila del negocio");
  return row;
}

async function defaultsFor(executor: Executor, businessId: string): Promise<TemplateDefaults> {
  const ctx = await getBusinessContext(executor, businessId);
  if (!ctx) throw notFound();
  return aiDefaultsForIndustry(ctx.business.industry);
}

/**
 * Configuración del agente de un negocio (API del módulo: panel y agente). La primera
 * lectura crea la fila con los defaults de la plantilla del rubro. 404 si el negocio no
 * existe.
 */
export async function getAiSettings(executor: Executor, businessId: string): Promise<AiSettingsView> {
  const defaults = await defaultsFor(executor, businessId);
  const row = await withTenant(executor, businessId, (tx) => ensureRow(tx, businessId, defaults));
  return toView(row, defaults);
}

// ── Escritura ───────────────────────────────────────────────────────────────

/** Texto opcional: recorta, y vacío = null (volver al default). */
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((s) => (s ? s : null));

const KnowledgeId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,59}$/, "Identificador inválido (minúsculas, números, - y _).");

const KnowledgeSectionInput = z
  .object({
    id: KnowledgeId.optional(),
    title: z.string().trim().min(1).max(80),
    // Una línea por ítem; las vacías se descartan.
    items: z
      .array(z.string().trim().max(500))
      .max(100)
      .transform((items) => items.filter((i) => i.length > 0)),
  })
  .strict();

const KnowledgeInput = z
  .array(KnowledgeSectionInput)
  .max(30)
  .refine(
    (sections) => sections.reduce((n, s) => n + s.title.length + s.items.reduce((m, i) => m + i.length, 0), 0) <= MAX_KNOWLEDGE_CHARS,
    `La base de conocimiento no puede pasar de ${MAX_KNOWLEDGE_CHARS.toLocaleString("es-CR")} caracteres en total.`,
  );

const FaqInput = z
  .array(z.object({ question: z.string().trim().min(1).max(300), answer: z.string().trim().min(1).max(1000) }).strict())
  .max(60)
  .refine(
    (faq) => faq.reduce((n, f) => n + f.question.length + f.answer.length, 0) <= MAX_FAQ_CHARS,
    `Las preguntas frecuentes no pueden pasar de ${MAX_FAQ_CHARS.toLocaleString("es-CR")} caracteres en total.`,
  );

// Claves del catálogo de textos (camelCase, como `appointmentBooked`). No se restringen al
// catálogo del agente: el resto del módulo (recordatorios, avisos) usa el mismo mapa.
const TextKey = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.]{0,59}$/, "Clave de texto inválida.");

const TextsInput = z
  .record(TextKey, z.string().trim().max(MAX_TEXT_OVERRIDE_LENGTH))
  .refine((t) => Object.keys(t).length <= MAX_TEXT_OVERRIDES, `Como máximo ${MAX_TEXT_OVERRIDES} textos personalizados.`)
  // Vacío = volver al texto de catálogo.
  .transform((t) => Object.fromEntries(Object.entries(t).filter(([, v]) => v.length > 0)));

/** Cuerpo de `PATCH /whatsapp/settings`: cualquier subconjunto de los campos. */
export const AiSettingsPatch = z
  .object({
    tone: OptionalText(MAX_TONE_LENGTH),
    register: z.enum(AI_REGISTERS),
    instructions: OptionalText(MAX_INSTRUCTIONS_LENGTH),
    knowledge: KnowledgeInput,
    faq: FaqInput,
    texts: TextsInput,
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "Indicá qué cambiar." });

export type AiSettingsPatchInput = z.output<typeof AiSettingsPatch>;

/** Ids de sección únicos: el que mandó el panel, o uno derivado del título. */
function withSectionIds(sections: AiSettingsPatchInput["knowledge"] & object): KnowledgeSection[] {
  const used = new Set<string>();
  return sections.map((s) => {
    const base = (s.id ?? slugify(s.title)).slice(0, 56) || "seccion";
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return { id, title: s.title, items: s.items };
  });
}

export interface UpdateAiSettingsOptions {
  /**
   * Revisa cómo QUEDARÍA la configuración (lo guardado + el cambio) antes de confirmar la
   * transacción; si lanza, no se guarda nada. La ruta lo usa para el presupuesto del prompt
   * del agente (./settingsRoutes.ts), que este archivo no puede medir sin depender del agente.
   */
  validate?: (view: AiSettingsView) => void;
}

/** Cambia la configuración del agente (los permisos los aplica la ruta). Devuelve cómo quedó. */
export async function updateAiSettings(
  executor: Executor,
  actor: AiSettingsActor,
  patch: AiSettingsPatchInput,
  options: UpdateAiSettingsOptions = {},
): Promise<AiSettingsView> {
  const { businessId } = actor;
  const defaults = await defaultsFor(executor, businessId);
  const row = await withTenant(executor, businessId, async (tx) => {
    await ensureRow(tx, businessId, defaults);
    // Bloquea la fila: dos guardados a la vez no se pisan a medias.
    await tx.select({ id: aiSettings.businessId }).from(aiSettings).where(eq(aiSettings.businessId, businessId)).for("update");
    const changes: Partial<typeof aiSettings.$inferInsert> = {};
    if (patch.tone !== undefined) changes.tone = patch.tone;
    if (patch.register !== undefined) changes.register = patch.register;
    if (patch.instructions !== undefined) changes.instructions = patch.instructions;
    if (patch.knowledge !== undefined) changes.knowledge = { sections: withSectionIds(patch.knowledge) };
    if (patch.faq !== undefined) changes.faq = patch.faq.map((f) => ({ question: f.question, answer: f.answer }));
    if (patch.texts !== undefined) changes.texts = patch.texts;
    const [updated] = await tx.update(aiSettings).set(changes).where(eq(aiSettings.businessId, businessId)).returning();
    options.validate?.(toView(updated, defaults));
    await recordConfigChange(tx, {
      businessId,
      entity: "ai_settings",
      entityId: null,
      snapshot: toView(updated, defaults),
      changedBy: actor.userId,
    });
    return updated;
  });
  return toView(row, defaults);
}
