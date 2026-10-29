import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordConfigChange } from "../../platform/audit/configHistory";
import { isTenantId, withTenant, type Executor } from "../../platform/db/scope";
import { assertSameIds } from "../../platform/http/access";
import { HttpError, ValidationError } from "../../platform/http/errors";
import type { Session } from "../../platform/http/routeTypes";
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES, customFields, type CustomField, type CustomFieldEntity, type CustomFieldType } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Campos personalizados de clientes y citas (PLAN-GESTION.md §3): las DEFINICIONES viven
// acá (`custom_fields`, tabla de business) y los VALORES en `custom_data` (jsonb) de
// `clients` y `appointments`, que validan sus dueños con `applyCustomDataPatch`.
//
// Cambiar una definición nunca rompe lo ya guardado:
//   • La clave (`key`) no cambia nunca: es la clave dentro de `custom_data`.
//   • "Borrar" desactiva (`active = false`): el valor guardado se conserva (oculto) y
//     vuelve si se reactiva. La clave queda reservada.
//   • El tipo solo cambia entre tipos compatibles (texto ↔ texto largo, opción → varias
//     opciones); para otro tipo se crea un campo nuevo.
//   • Quitar una opción o volver obligatorio un campo no toca las fichas: lo guardado se
//     sigue mostrando; las reglas nuevas aplican a lo que se escriba desde ahí.
//
// Configuración › Campos personalizados (rutas en ./clientSettingsRoutes.ts) es del plan
// Pro (CRM completo de clientes).
// ─────────────────────────────────────────────────────────────────────────────

/** Máximo de campos (activos e inactivos) por entidad. */
export const MAX_CUSTOM_FIELDS_PER_ENTITY = 50;
export const MAX_CUSTOM_FIELD_OPTIONS = 30;
const MAX_KEY_LENGTH = 40;
const TEXT_MAX: Record<"text" | "long_text", number> = { text: 500, long_text: 5000 };
const NUMBER_LIMIT = 1_000_000_000_000;

/** Cambios de tipo permitidos sin tocar lo guardado. */
const COMPATIBLE_TYPES: Readonly<Record<CustomFieldType, readonly CustomFieldType[]>> = {
  text: ["long_text"],
  long_text: ["text"],
  number: [],
  date: [],
  boolean: [],
  select: ["multi_select"],
  multi_select: [],
};

const hasOptions = (type: CustomFieldType) => type === "select" || type === "multi_select";

/** Definición tal como la ven el panel y los demás módulos. */
export interface CustomFieldView {
  id: string;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  /** Opciones de `select` / `multi_select` (vacío para el resto). */
  options: string[];
  required: boolean;
  position: number;
  active: boolean;
}

export function toCustomFieldView(row: CustomField): CustomFieldView {
  return {
    id: row.id,
    entity: row.entity as CustomFieldEntity,
    key: row.key,
    label: row.label,
    type: row.type as CustomFieldType,
    options: row.options ?? [],
    required: row.required,
    position: row.position,
    active: row.active,
  };
}

// ── Lectura ─────────────────────────────────────────────────────────────────

export interface ListCustomFieldsOptions {
  entity?: CustomFieldEntity;
  /** Incluir los desactivados (Configuración). Default: solo activos. */
  includeInactive?: boolean;
}

/** Definiciones del negocio, en orden (entidad, posición, alta). */
export async function listCustomFields(
  executor: Executor,
  businessId: string,
  options: ListCustomFieldsOptions = {},
): Promise<CustomFieldView[]> {
  const rows = await withTenant(executor, businessId, (tx) =>
    tx
      .select()
      .from(customFields)
      .where(
        and(
          eq(customFields.businessId, businessId),
          options.entity ? eq(customFields.entity, options.entity) : undefined,
          options.includeInactive ? undefined : eq(customFields.active, true),
        ),
      )
      .orderBy(asc(customFields.entity), asc(customFields.position), asc(customFields.createdAt)),
  );
  return rows.map(toCustomFieldView);
}

// ── Esquemas de la API ──────────────────────────────────────────────────────

const Label = z.string().trim().min(1, "Escribí el nombre del campo.").max(80);
const Options = z.array(z.string().trim().min(1, "Una opción no puede quedar vacía.").max(60)).max(MAX_CUSTOM_FIELD_OPTIONS);

export const NewCustomFieldInput = z
  .object({
    entity: z.enum(CUSTOM_FIELD_ENTITIES),
    label: Label,
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: Options.optional(),
    required: z.boolean().optional(),
    /** Clave en snake_case (opcional: sale del nombre). */
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]*$/, "La clave va en minúsculas, sin espacios ni tildes (p. ej. tipo_de_piel).")
      .max(MAX_KEY_LENGTH)
      .optional(),
  })
  .strict();

export const CustomFieldPatch = z
  .object({
    label: Label.optional(),
    type: z.enum(CUSTOM_FIELD_TYPES).optional(),
    options: Options.optional(),
    required: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "Indicá qué cambiar." });

export const CustomFieldOrderInput = z.object({ entity: z.enum(CUSTOM_FIELD_ENTITIES), ids: z.array(z.uuid()).max(MAX_CUSTOM_FIELDS_PER_ENTITY) }).strict();

/** Valores de `custom_data` en un cuerpo (la forma; el contenido lo valida `applyCustomDataPatch`). */
export const CustomDataInput = z.record(z.string().max(60), z.unknown()).refine((r) => Object.keys(r).length <= MAX_CUSTOM_FIELDS_PER_ENTITY, {
  message: "Demasiados campos.",
});

// ── Alta, edición, orden ────────────────────────────────────────────────────

/** Clave snake_case desde el nombre ("Tipo de piel" → "tipo_de_piel"). */
export function customFieldKeyFrom(label: string): string {
  let key = label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(key)) key = `campo_${key}`.replace(/_+$/, "");
  return key.slice(0, MAX_KEY_LENGTH).replace(/_+$/, "") || "campo";
}

/** Opciones sin repetir (sin distinguir mayúsculas), en el orden en que llegaron. */
function uniqueOptions(options: readonly string[]): string[] {
  const seen = new Set<string>();
  return options.filter((o) => {
    const k = o.trim().toLocaleLowerCase("es");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function checkOptions(type: CustomFieldType, options: readonly string[]): string | null {
  if (!hasOptions(type)) return options.length > 0 ? "Las opciones son solo para los campos de opción." : null;
  return options.length < 2 ? "Cargá al menos dos opciones." : null;
}

const notFound = () => new HttpError(404, "No encontramos ese campo.", "not_found");

function snapshotOf(field: CustomFieldView) {
  return { ...field };
}

export async function createCustomField(
  db: Executor,
  session: Pick<Session, "businessId" | "userId">,
  input: z.output<typeof NewCustomFieldInput>,
): Promise<CustomFieldView> {
  const { businessId } = session;
  const options = uniqueOptions(input.options ?? []);
  const optionsError = checkOptions(input.type, options);
  if (optionsError) throw new ValidationError({ "body.options": optionsError });

  const field = await withTenant(db, businessId, async (tx) => {
    const existing = await tx
      .select()
      .from(customFields)
      .where(and(eq(customFields.businessId, businessId), eq(customFields.entity, input.entity)))
      .for("update");
    if (existing.length >= MAX_CUSTOM_FIELDS_PER_ENTITY) {
      throw new HttpError(409, `Llegaste al máximo de ${MAX_CUSTOM_FIELDS_PER_ENTITY} campos.`, "custom_fields_limit");
    }
    const label = input.label.trim();
    if (existing.some((f) => f.active && f.label.toLocaleLowerCase("es") === label.toLocaleLowerCase("es"))) {
      throw new ValidationError({ "body.label": "Ya hay un campo con ese nombre." });
    }
    const taken = new Set(existing.map((f) => f.key));
    let key = input.key ?? customFieldKeyFrom(label);
    if (input.key && taken.has(key)) throw new ValidationError({ "body.key": "Esa clave ya existe (también entre los campos desactivados)." });
    const base = key;
    for (let n = 2; taken.has(key); n++) key = `${base.slice(0, MAX_KEY_LENGTH - String(n).length - 1)}_${n}`;
    const position = existing.reduce((max, f) => Math.max(max, f.position + 1), 0);
    const [row] = await tx
      .insert(customFields)
      .values({ businessId, entity: input.entity, key, label, type: input.type, options, required: input.required ?? false, position })
      .returning();
    const view = toCustomFieldView(row);
    await recordConfigChange(tx, { businessId, entity: "custom_field", entityId: row.id, snapshot: snapshotOf(view), changedBy: session.userId });
    return view;
  });
  return field;
}

export async function updateCustomField(
  db: Executor,
  session: Pick<Session, "businessId" | "userId">,
  fieldId: string,
  patch: z.output<typeof CustomFieldPatch>,
): Promise<CustomFieldView> {
  const { businessId } = session;
  if (!isTenantId(fieldId)) throw notFound();
  return withTenant(db, businessId, async (tx) => {
    const [current] = await tx
      .select()
      .from(customFields)
      .where(and(eq(customFields.businessId, businessId), eq(customFields.id, fieldId)))
      .limit(1)
      .for("update");
    if (!current) throw notFound();
    const fields: Record<string, string> = {};
    const changes: Partial<CustomField> = {};
    const currentType = current.type as CustomFieldType;

    const type = patch.type ?? currentType;
    if (patch.type !== undefined && patch.type !== currentType) {
      if (!COMPATIBLE_TYPES[currentType].includes(patch.type)) {
        fields["body.type"] = "Ese cambio de tipo podría romper lo ya cargado: creá un campo nuevo y desactivá este.";
      } else changes.type = patch.type;
    }
    const options = patch.options !== undefined ? uniqueOptions(patch.options) : hasOptions(type) ? (current.options ?? []) : [];
    const optionsError = checkOptions(type, options);
    if (optionsError && (patch.options !== undefined || patch.type !== undefined)) fields["body.options"] = optionsError;
    else if (patch.options !== undefined || (patch.type !== undefined && !hasOptions(type))) changes.options = options;

    // Nombre sin repetir entre los activos (también al reactivar uno).
    const label = patch.label?.trim() ?? current.label;
    if (patch.label !== undefined || (patch.active === true && !current.active)) {
      const others = await tx
        .select({ id: customFields.id, label: customFields.label })
        .from(customFields)
        .where(and(eq(customFields.businessId, businessId), eq(customFields.entity, current.entity), eq(customFields.active, true)));
      if (others.some((f) => f.id !== current.id && f.label.toLocaleLowerCase("es") === label.toLocaleLowerCase("es"))) {
        fields[patch.label !== undefined ? "body.label" : "body.active"] = "Ya hay un campo activo con ese nombre.";
      } else if (patch.label !== undefined) changes.label = label;
    }
    if (patch.required !== undefined) changes.required = patch.required;
    if (patch.active !== undefined) changes.active = patch.active;
    if (Object.keys(fields).length > 0) throw new ValidationError(fields);
    if (Object.keys(changes).length === 0) return toCustomFieldView(current);

    const [row] = await tx
      .update(customFields)
      .set(changes)
      .where(and(eq(customFields.businessId, businessId), eq(customFields.id, fieldId)))
      .returning();
    const view = toCustomFieldView(row);
    await recordConfigChange(tx, { businessId, entity: "custom_field", entityId: row.id, snapshot: snapshotOf(view), changedBy: session.userId });
    return view;
  });
}

/** "Borrar" un campo: se desactiva (lo cargado se conserva, oculto, y vuelve si se reactiva). */
export function archiveCustomField(db: Executor, session: Pick<Session, "businessId" | "userId">, fieldId: string): Promise<CustomFieldView> {
  return updateCustomField(db, session, fieldId, { active: false });
}

/** Nuevo orden de los campos de una entidad (tiene que traer todos, activos e inactivos). */
export async function reorderCustomFields(
  db: Executor,
  session: Pick<Session, "businessId" | "userId">,
  input: z.output<typeof CustomFieldOrderInput>,
): Promise<CustomFieldView[]> {
  const { businessId } = session;
  await withTenant(db, businessId, async (tx) => {
    const current = await tx
      .select({ id: customFields.id })
      .from(customFields)
      .where(and(eq(customFields.businessId, businessId), eq(customFields.entity, input.entity)))
      .for("update");
    assertSameIds(
      current.map((f) => f.id),
      input.ids,
    );
    for (const [position, id] of input.ids.entries()) {
      await tx
        .update(customFields)
        .set({ position })
        .where(and(eq(customFields.businessId, businessId), eq(customFields.id, id.toLowerCase())));
    }
    await recordConfigChange(tx, {
      businessId,
      entity: "custom_fields_order",
      entityId: null,
      snapshot: { entity: input.entity, ids: input.ids },
      changedBy: session.userId,
    });
  });
  return listCustomFields(db, businessId, { entity: input.entity, includeInactive: true });
}

// ── Valores (`custom_data`) ─────────────────────────────────────────────────

/** ¿El valor cuenta como "cargado"? (para los obligatorios). */
export function hasCustomValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(text: string): boolean {
  if (!RE_DATE.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

/**
 * Valida UN valor contra su definición. Devuelve el valor normalizado, `undefined` para
 * "vaciar" (null, "", [] ) o un mensaje de error.
 */
export function normalizeCustomValue(def: Pick<CustomFieldView, "type" | "options">, raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "") || (Array.isArray(raw) && raw.length === 0)) {
    return { ok: true, value: undefined };
  }
  switch (def.type) {
    case "text":
    case "long_text": {
      if (typeof raw !== "string") return { ok: false, error: "Se esperaba un texto." };
      const text = raw.trim();
      const max = TEXT_MAX[def.type];
      return text.length > max ? { ok: false, error: `Debe tener como máximo ${max} caracteres.` } : { ok: true, value: text };
    }
    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) return { ok: false, error: "Se esperaba un número." };
      return Math.abs(raw) > NUMBER_LIMIT ? { ok: false, error: "El número es demasiado grande." } : { ok: true, value: raw };
    }
    case "date": {
      if (typeof raw !== "string" || !isRealDate(raw)) return { ok: false, error: "Fecha inválida (formato AAAA-MM-DD)." };
      return { ok: true, value: raw };
    }
    case "boolean":
      return typeof raw === "boolean" ? { ok: true, value: raw } : { ok: false, error: "Se esperaba sí o no." };
    case "select": {
      if (typeof raw !== "string" || !def.options.includes(raw)) return { ok: false, error: "Elegí una de las opciones." };
      return { ok: true, value: raw };
    }
    case "multi_select": {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || !def.options.includes(v))) {
        return { ok: false, error: "Elegí entre las opciones." };
      }
      // Sin repetir y en el orden de las opciones.
      const picked = new Set(raw as string[]);
      return { ok: true, value: def.options.filter((o) => picked.has(o)) };
    }
  }
}

export interface CustomDataPatchOptions {
  /** Prefijo de los errores por campo (default `body.customData`). */
  fieldPrefix?: string;
  /** Exigir los obligatorios en el resultado (formulario completo). Default true. */
  checkRequired?: boolean;
}

/**
 * Aplica cambios a `custom_data` validándolos contra las definiciones ACTIVAS de la
 * entidad: solo se tocan las claves del cambio (las demás, incluidas las de campos
 * desactivados o valores de una definición vieja, quedan como están); null/""/[] borra.
 * Con `checkRequired`, los obligatorios tienen que quedar cargados. Devuelve el resultado y
 * los errores por campo (`body.customData.<clave>`).
 */
export function applyCustomDataPatch(
  definitions: readonly CustomFieldView[],
  current: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
  options: CustomDataPatchOptions = {},
): { data: Record<string, unknown>; errors: Record<string, string> } {
  const prefix = options.fieldPrefix ?? "body.customData";
  const active = new Map(definitions.filter((d) => d.active).map((d) => [d.key, d]));
  const data: Record<string, unknown> = { ...current };
  const errors: Record<string, string> = {};
  for (const [key, raw] of Object.entries(patch)) {
    const def = active.get(key);
    if (!def) {
      errors[`${prefix}.${key}`] = "Ese campo no existe o está desactivado.";
      continue;
    }
    const result = normalizeCustomValue(def, raw);
    if (!result.ok) errors[`${prefix}.${key}`] = result.error;
    else if (result.value === undefined) delete data[key];
    else data[key] = result.value;
  }
  if (options.checkRequired ?? true) {
    for (const def of active.values()) {
      if (def.required && !hasCustomValue(data[def.key]) && !errors[`${prefix}.${def.key}`]) {
        errors[`${prefix}.${def.key}`] = "Campo obligatorio.";
      }
    }
  }
  return { data, errors };
}

// ── Texto (importar y exportar CSV) ─────────────────────────────────────────

const TRUE_WORDS = new Set(["si", "sí", "s", "yes", "y", "true", "verdadero", "1", "x"]);
const FALSE_WORDS = new Set(["no", "n", "false", "falso", "0"]);

/** "1.234,5" / "1,234.5" / "1234.5" → número (o null). */
function parseNumberText(text: string): number | null {
  const t = text.replace(/\s/g, "");
  if (!/^[-+]?[\d.,]+$/.test(t)) return null;
  const lastComma = t.lastIndexOf(",");
  const lastDot = t.lastIndexOf(".");
  let normalized = t;
  if (lastComma > lastDot) normalized = t.replace(/\./g, "").replace(",", ".");
  else if (lastDot > lastComma) normalized = t.replace(/,/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** "17/05/1990", "17-05-1990" o "1990-05-17" → "1990-05-17" (o null). */
export function parseDateText(text: string): string | null {
  const t = text.trim();
  if (isRealDate(t)) return t;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return isRealDate(iso) ? iso : null;
}

/** Valor de un campo desde el texto de una celda (importación). Mismas reglas que `normalizeCustomValue`. */
export function parseCustomFieldText(def: Pick<CustomFieldView, "type" | "options">, text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const t = text.trim();
  if (t === "") return { ok: true, value: undefined };
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("es").trim();
  switch (def.type) {
    case "number": {
      const n = parseNumberText(t);
      return n === null ? { ok: false, error: "Se esperaba un número." } : normalizeCustomValue(def, n);
    }
    case "date": {
      const d = parseDateText(t);
      return d === null ? { ok: false, error: "Fecha inválida (usá AAAA-MM-DD o DD/MM/AAAA)." } : normalizeCustomValue(def, d);
    }
    case "boolean": {
      const f = fold(t);
      if (TRUE_WORDS.has(f)) return { ok: true, value: true };
      if (FALSE_WORDS.has(f)) return { ok: true, value: false };
      return { ok: false, error: "Se esperaba sí o no." };
    }
    case "select": {
      const option = def.options.find((o) => fold(o) === fold(t));
      return option ? { ok: true, value: option } : { ok: false, error: `«${t}» no es una de las opciones.` };
    }
    case "multi_select": {
      const parts = t.split(/[;,|]/).map((p) => p.trim()).filter(Boolean);
      const picked: string[] = [];
      for (const part of parts) {
        const option = def.options.find((o) => fold(o) === fold(part));
        if (!option) return { ok: false, error: `«${part}» no es una de las opciones.` };
        picked.push(option);
      }
      return normalizeCustomValue(def, picked);
    }
    default:
      return normalizeCustomValue(def, t);
  }
}

/** Valor guardado → texto de una celda (exportación). Lo que no calza con el tipo sale tal cual. */
export function formatCustomFieldValue(def: Pick<CustomFieldView, "type">, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (def.type === "boolean" && typeof value === "boolean") return value ? "Sí" : "No";
  if (Array.isArray(value)) return value.map(String).join("; ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
