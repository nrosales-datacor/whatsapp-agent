import { readFileSync } from "node:fs";
import { z } from "zod";
import { spanishErrorMap } from "../../platform/http/validation";
import { ClientStatusRulesOverridesSchema } from "./statusRules";
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES } from "./schema";
import { DEFAULT_TERMINOLOGY, type Terminology } from "./settings";

// ─────────────────────────────────────────────────────────────────────────────
// Plantillas de rubro (PLAN-GESTION.md §3, opción B): un JSON por rubro en ./templates/
// que precarga al crear el negocio categorías y servicios de ejemplo, terminología,
// reglas de estado de cliente, campos personalizados y una sección `ai` (instrucciones
// base del agente y textos de recordatorio). Sumar un rubro = sumar su JSON y su nombre
// en INDUSTRIES, sin código ni migración.
//
// Quién aplica qué:
//   • business (`applyIndustryTemplate`, ./provisioning.ts): terminología, reglas de
//     estado y campos personalizados (tablas de business).
//   • catalog (`applyCatalogTemplate`): categorías y servicios. business no puede
//     importar catalog (catalog depende de business), así que se le pasa como paso.
//   • whatsapp (I2): la sección `ai`. Acá solo se valida y se expone.
//
// El JSON se valida con Zod al leerlo (una vez por proceso): una plantilla rota falla en
// el primer uso y en test/unit/industryTemplates.test.ts, no en silencio.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rubros con plantilla. La columna `industry` no tiene CHECK a propósito: sumar un rubro
 * es sumar su plantilla y su nombre acá, sin migración.
 */
export const INDUSTRIES = ["generic", "dental", "aesthetics", "nails"] as const;
export type Industry = (typeof INDUSTRIES)[number];

/** Marcadores que pueden llevar los textos de recordatorio (los reemplaza el módulo whatsapp). */
export const REMINDER_PLACEHOLDERS = ["clientName", "businessName", "locationName", "staffName", "date", "time", "services"] as const;

/** Registro con el que el agente le habla al cliente final (E11). */
export const AI_REGISTERS = ["vos", "tu", "usted"] as const;

const TERMINOLOGY_KEYS = Object.keys(DEFAULT_TERMINOLOGY) as [keyof Terminology, ...(keyof Terminology)[]];

const Term = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((s) => s === s.toLocaleLowerCase("es"), "La terminología va en minúscula (la UI la capitaliza).");

const TerminologySchema = z.partialRecord(z.enum(TERMINOLOGY_KEYS), Term);

const CustomFieldSchema = z
  .object({
    entity: z.enum(CUSTOM_FIELD_ENTITIES),
    key: z.string().regex(/^[a-z][a-z0-9_]*$/, "La clave va en snake_case."),
    label: z.string().trim().min(1).max(80),
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
    required: z.boolean().default(false),
  })
  .strict()
  .refine((f) => (f.type === "select" || f.type === "multi_select" ? f.options.length >= 2 : f.options.length === 0), {
    message: "Las opciones van solo en select / multi_select (y ahí, al menos dos).",
    path: ["options"],
  });

const TemplateServiceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).optional(),
    durationMin: z.int().min(5).max(24 * 60).multipleOf(5),
    bufferMin: z.int().min(0).max(240).multipleOf(5).default(0),
    // Precio de referencia en céntimos, o null = sin precio (el negocio lo carga después).
    priceCents: z.int().min(0).nullable(),
    variablePrice: z.boolean().default(false),
    onlineBooking: z.boolean().default(true),
  })
  .strict();

const TemplateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    services: z.array(TemplateServiceSchema).min(1).max(40),
  })
  .strict();

const ReminderText = z
  .string()
  .trim()
  .min(10)
  .max(600)
  .refine(
    (text) => [...text.matchAll(/\{([^}]*)\}/g)].every((m) => (REMINDER_PLACEHOLDERS as readonly string[]).includes(m[1])),
    `Marcador desconocido: los permitidos son ${REMINDER_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}.`,
  );

const IndustryTemplateSchema = z
  .object({
    $comment: z.string().optional(),
    industry: z.enum(INDUSTRIES),
    /** Nombre del rubro para mostrar ("Odontología"). */
    label: z.string().trim().min(1).max(60),
    terminology: TerminologySchema,
    clientStatusRules: ClientStatusRulesOverridesSchema,
    customFields: z.array(CustomFieldSchema).max(30),
    catalog: z.object({ categories: z.array(TemplateCategorySchema).min(1).max(20) }).strict(),
    ai: z
      .object({
        register: z.enum(AI_REGISTERS),
        instructions: z.string().trim().min(40).max(4000),
        reminders: z.object({ dayBefore: ReminderText, sameDay: ReminderText }).strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const seen = new Set<string>();
    t.customFields.forEach((f, i) => {
      const id = `${f.entity}:${f.key}`;
      if (seen.has(id)) ctx.addIssue({ code: "custom", message: `Campo repetido: ${id}.`, path: ["customFields", i, "key"] });
      seen.add(id);
    });
    const categories = new Set<string>();
    const services = new Set<string>();
    t.catalog.categories.forEach((c, i) => {
      if (categories.has(c.name)) ctx.addIssue({ code: "custom", message: `Categoría repetida: ${c.name}.`, path: ["catalog", "categories", i, "name"] });
      categories.add(c.name);
      c.services.forEach((s, j) => {
        if (services.has(s.name)) {
          ctx.addIssue({ code: "custom", message: `Servicio repetido: ${s.name}.`, path: ["catalog", "categories", i, "services", j, "name"] });
        }
        services.add(s.name);
      });
    });
  });

export type IndustryTemplate = z.output<typeof IndustryTemplateSchema>;
export type TemplateCatalog = IndustryTemplate["catalog"];
export type TemplateCategory = TemplateCatalog["categories"][number];
export type TemplateService = TemplateCategory["services"][number];
export type TemplateCustomField = IndustryTemplate["customFields"][number];
export type TemplateAi = IndustryTemplate["ai"];

export function isIndustry(value: unknown): value is Industry {
  return typeof value === "string" && (INDUSTRIES as readonly string[]).includes(value);
}

/**
 * Valida el contenido de una plantilla (lo usa el loader y el test de plantillas). Lanza
 * con el detalle de cada problema si no cumple.
 */
export function parseIndustryTemplate(raw: unknown, source = "plantilla"): IndustryTemplate {
  const result = IndustryTemplateSchema.safeParse(raw, { error: spanishErrorMap });
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ");
    throw new Error(`${source} inválida: ${detail}`);
  }
  return result.data;
}

const cache = new Map<Industry, IndustryTemplate>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Plantilla de un rubro, validada y congelada (se lee del disco una vez por proceso). */
export function loadIndustryTemplate(industry: Industry): IndustryTemplate {
  const hit = cache.get(industry);
  if (hit) return hit;
  if (!isIndustry(industry)) throw new Error(`loadIndustryTemplate: rubro desconocido "${String(industry)}"`);
  const file = new URL(`./templates/${industry}.json`, import.meta.url);
  const template = deepFreeze(parseIndustryTemplate(JSON.parse(readFileSync(file, "utf8")), `templates/${industry}.json`));
  if (template.industry !== industry) throw new Error(`templates/${industry}.json declara industry "${template.industry}"`);
  cache.set(industry, template);
  return template;
}

/** Todas las plantillas, en el orden de INDUSTRIES. */
export function listIndustryTemplates(): IndustryTemplate[] {
  return INDUSTRIES.map(loadIndustryTemplate);
}
