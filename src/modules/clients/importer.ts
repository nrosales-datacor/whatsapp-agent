import { and, eq, inArray } from "drizzle-orm";
import { recordAudit } from "../../platform/audit/auditLog";
import { withTenant, type Executor } from "../../platform/db/scope";
import { HttpError, ValidationError } from "../../platform/http/errors";
import { getBusinessContext, listCustomFields, parseCustomFieldText, parseDateText, type BusinessContext, type CustomFieldView } from "../business";
import { CsvError, parseCsv, type CsvDelimiter } from "./csv";
import { DEFAULT_PHONE_COUNTRY, normalizePhone } from "./phone";
import { clients, type Client, type NewClient } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Importar clientes desde un CSV (`POST /clients/import`, CRM del Pro, dueño y admin). Un
// solo endpoint en dos pasos, con la misma respuesta:
//
//   1. Vista previa (`commit: false`): parsea, detecta si la primera fila son encabezados y
//      propone un mapeo de columnas (por nombre: "Teléfono", "Celular", "Correo", los
//      campos personalizados por su nombre…); valida cada fila y dice qué haría (crear,
//      actualizar, omitir o error) sin tocar la base.
//   2. Importar (`commit: true`, con el mapeo que eligió la persona): lo mismo, y escribe
//      las filas válidas en UNA transacción (todo el lote o nada). Las filas con error se
//      saltean y vuelven en el reporte con su número de fila y el motivo.
//
// Reglas:
//   • Dedupe por teléfono normalizado a E.164 (con el país del negocio): si ya hay un
//     cliente con ese teléfono se actualiza (o se omite, con `onExisting: "skip"`); dentro
//     del archivo, un teléfono repetido es error en la segunda fila. Sin teléfono se crea.
//   • Actualizar solo pisa lo que la fila trae cargado (una celda vacía nunca borra);
//     las etiquetas se suman a las que tenía; los campos personalizados, clave por clave.
//   • Un cliente nuevo necesita nombre (columna de nombre, o nombre + apellidos).
//   • Los obligatorios de los campos personalizados no se exigen al importar (un archivo
//     viejo no los trae); el tipo de cada valor sí se valida.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_IMPORT_ROWS = 5000;
const MAX_IMPORT_COLUMNS = 60;
const PREVIEW_ROWS = 20;
const MAX_REPORTED_ERRORS = 500;
const INSERT_CHUNK = 500;

/** Campos fijos a los que se puede mapear una columna (más `custom:<clave>`). */
export const IMPORT_FIELDS = ["name", "first_name", "last_name", "phone", "email", "birth_date", "tags", "notes", "source"] as const;
export type ImportBaseField = (typeof IMPORT_FIELDS)[number];
export type ImportField = ImportBaseField | `custom:${string}`;

const FIELD_LABELS: Record<ImportBaseField, string> = {
  name: "Nombre completo",
  first_name: "Nombre",
  last_name: "Apellidos",
  phone: "Teléfono",
  email: "Correo",
  birth_date: "Fecha de nacimiento",
  tags: "Etiquetas",
  notes: "Notas",
  source: "Origen",
};

/** Encabezados conocidos (sin tildes, en minúscula) → campo. */
const HEADER_SYNONYMS: Record<ImportBaseField, readonly string[]> = {
  name: ["nombre completo", "nombre y apellidos", "nombre y apellido", "cliente", "paciente", "full name", "name", "nombre"],
  first_name: ["nombres", "primer nombre", "first name", "given name"],
  last_name: ["apellidos", "apellido", "last name", "surname", "family name"],
  phone: ["telefono", "tel", "celular", "movil", "whatsapp", "numero", "numero de telefono", "telefono movil", "phone", "mobile", "phone number"],
  email: ["correo", "correo electronico", "email", "e-mail", "mail"],
  birth_date: ["fecha de nacimiento", "nacimiento", "fecha nacimiento", "cumpleanos", "birthday", "birth date", "date of birth"],
  tags: ["etiquetas", "etiqueta", "tags", "grupos", "grupo"],
  notes: ["notas", "nota", "observaciones", "comentarios", "notes"],
  source: ["origen", "fuente", "como nos conocio", "source", "referido por"],
};

export type ImportAction = "create" | "update" | "skip" | "error";

export interface ImportOptions {
  csv: string;
  /** null/undefined = detectar. */
  hasHeader?: boolean | null;
  /** Columna (índice desde 0, como texto) → campo, o null para ignorarla. Sin mapeo = el sugerido. */
  mapping?: Record<string, string | null> | null;
  onExisting?: "update" | "skip";
  commit?: boolean;
  /** Actor del rastro de auditoría (al importar). */
  actor?: string;
}

export interface ImportColumn {
  index: number;
  /** Texto del encabezado (o null si el archivo no tiene). */
  header: string | null;
  /** Primeros valores de la columna (para el mapeo). */
  samples: string[];
}

export interface ImportRowResult {
  /** Línea del archivo. */
  row: number;
  action: ImportAction;
  name: string | null;
  phone: string | null;
  email: string | null;
  errors: string[];
}

export interface ImportReport {
  delimiter: CsvDelimiter;
  hasHeader: boolean;
  columns: ImportColumn[];
  /** Mapeo usado (el sugerido si no se mandó uno). */
  mapping: Record<string, ImportField | null>;
  /** Campos a los que se puede mapear (fijos y personalizados activos). */
  fields: { id: ImportField; label: string }[];
  totalRows: number;
  summary: Record<ImportAction, number>;
  /** Primeras filas con lo que pasaría (o pasó). */
  preview: ImportRowResult[];
  /** Filas con error (hasta 500). */
  errors: { row: number; messages: string[] }[];
  committed: boolean;
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const looksLikeData = (cell: string) => RE_EMAIL.test(cell.trim()) || /^\+?[\d\s().-]{7,}$/.test(cell.trim()) || parseDateText(cell) !== null;

/** Campo sugerido para un encabezado (null = ignorar). */
function suggestField(header: string, customFields: readonly CustomFieldView[]): ImportField | null {
  const h = fold(header);
  if (!h) return null;
  const custom = customFields.find((f) => fold(f.label) === h || f.key === h.replace(/ /g, "_"));
  if (custom) return `custom:${custom.key}`;
  for (const field of IMPORT_FIELDS) if (HEADER_SYNONYMS[field].includes(h)) return field;
  return null;
}

/** ¿La primera fila son encabezados? Sí si algún valor calza con un campo y ninguno parece un dato. */
function detectHeader(first: readonly string[], customFields: readonly CustomFieldView[]): boolean {
  if (first.some(looksLikeData)) return false;
  return first.some((cell) => suggestField(cell, customFields) !== null);
}

function suggestMapping(headers: readonly (string | null)[], columnCount: number, customFields: readonly CustomFieldView[]): Record<string, ImportField | null> {
  const mapping: Record<string, ImportField | null> = {};
  const used = new Set<ImportField>();
  for (let i = 0; i < columnCount; i++) {
    const field = headers[i] ? suggestField(headers[i] as string, customFields) : null;
    mapping[String(i)] = field && !used.has(field) ? field : null;
    if (field) used.add(field);
  }
  // "Nombre" + "Apellidos" en columnas separadas: "Nombre" es el nombre de pila.
  if (used.has("last_name")) {
    for (const [col, field] of Object.entries(mapping)) if (field === "name") mapping[col] = used.has("first_name") ? null : "first_name";
  }
  return mapping;
}

function validateMapping(raw: Record<string, string | null>, columnCount: number, customFields: readonly CustomFieldView[]): Record<string, ImportField | null> {
  const known = new Set<string>([...IMPORT_FIELDS, ...customFields.map((f) => `custom:${f.key}`)]);
  const mapping: Record<string, ImportField | null> = {};
  const used = new Set<string>();
  const fields: Record<string, string> = {};
  for (const [col, field] of Object.entries(raw)) {
    const index = Number(col);
    if (!Number.isInteger(index) || index < 0 || index >= columnCount) {
      fields[`body.mapping.${col}`] = "Esa columna no existe en el archivo.";
      continue;
    }
    if (field === null || field === "") {
      mapping[col] = null;
      continue;
    }
    if (!known.has(field)) fields[`body.mapping.${col}`] = "Campo desconocido.";
    else if (used.has(field)) fields[`body.mapping.${col}`] = "Ese campo ya está asignado a otra columna.";
    else {
      used.add(field);
      mapping[col] = field as ImportField;
    }
  }
  if (Object.keys(fields).length > 0) throw new ValidationError(fields);
  const values = new Set(Object.values(mapping));
  if (!values.has("name") && !values.has("first_name") && !values.has("phone")) {
    throw new HttpError(400, "Asigná al menos la columna del nombre o la del teléfono.", "import_mapping_incomplete");
  }
  return mapping;
}

interface Candidate {
  line: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  birthDate: string | null;
  tags: string[];
  notes: string | null;
  source: string | null;
  customData: Record<string, unknown>;
  errors: string[];
}

function uniqueTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const t = tag.trim();
    const key = t.toLocaleLowerCase("es");
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function readRow(
  cells: readonly string[],
  line: number,
  mapping: Record<string, ImportField | null>,
  country: string,
  customByKey: ReadonlyMap<string, CustomFieldView>,
  today: string,
): Candidate {
  const c: Candidate = { line, name: null, phone: null, email: null, birthDate: null, tags: [], notes: null, source: null, customData: {}, errors: [] };
  let first = "";
  let last = "";
  for (const [col, field] of Object.entries(mapping)) {
    if (!field) continue;
    // Un apóstrofo adelante es el escape de fórmulas de una exportación: se quita.
    const raw = (cells[Number(col)] ?? "").trim().replace(/^'(?=[=+\-@])/, "");
    if (raw === "") continue;
    switch (field) {
      case "name":
        c.name = raw;
        break;
      case "first_name":
        first = raw;
        break;
      case "last_name":
        last = raw;
        break;
      case "phone": {
        const e164 = normalizePhone(raw, country);
        if (e164) c.phone = e164;
        else c.errors.push(`Teléfono inválido: «${raw}».`);
        break;
      }
      case "email":
        if (RE_EMAIL.test(raw) && raw.length <= 320) c.email = raw.toLowerCase();
        else c.errors.push(`Correo inválido: «${raw}».`);
        break;
      case "birth_date": {
        const date = parseDateText(raw);
        if (!date) c.errors.push(`Fecha de nacimiento inválida: «${raw}» (usá AAAA-MM-DD o DD/MM/AAAA).`);
        else if (date > today || date < "1900-01-01") c.errors.push(`Fecha de nacimiento fuera de rango: «${raw}».`);
        else c.birthDate = date;
        break;
      }
      case "tags": {
        const tags = uniqueTags(raw.split(/[;,|]/));
        if (tags.some((t) => t.length > 40)) c.errors.push("Una etiqueta puede tener hasta 40 caracteres.");
        else if (tags.length > 30) c.errors.push("Hasta 30 etiquetas por cliente.");
        else c.tags = tags;
        break;
      }
      case "notes":
        if (raw.length > 5000) c.errors.push("Las notas pueden tener hasta 5000 caracteres.");
        else c.notes = raw;
        break;
      case "source":
        c.source = raw.slice(0, 60);
        break;
      default: {
        const def = customByKey.get(field.slice("custom:".length));
        if (!def) break;
        const parsed = parseCustomFieldText(def, raw);
        if (!parsed.ok) c.errors.push(`${def.label}: ${parsed.error}`);
        else if (parsed.value !== undefined) c.customData[def.key] = parsed.value;
      }
    }
  }
  if (!c.name && (first || last)) c.name = `${first} ${last}`.trim();
  if (c.name && c.name.length > 120) {
    c.errors.push("El nombre puede tener hasta 120 caracteres.");
    c.name = c.name.slice(0, 120);
  }
  return c;
}

/** Cambios para un cliente que ya existe: solo lo cargado; etiquetas y campos se suman. */
function updateFor(existing: Client, c: Candidate): Partial<NewClient> {
  const changes: Partial<NewClient> = {};
  if (c.name && c.name !== existing.name) changes.name = c.name;
  if (c.email && c.email !== existing.email) changes.email = c.email;
  if (c.birthDate && c.birthDate !== existing.birthDate) changes.birthDate = c.birthDate;
  if (c.notes && c.notes !== existing.notes) changes.notes = c.notes;
  if (c.source && c.source !== existing.source) changes.source = c.source;
  if (c.tags.length > 0) {
    const merged = uniqueTags([...(existing.tags ?? []), ...c.tags]).slice(0, 30);
    if (JSON.stringify(merged) !== JSON.stringify(existing.tags ?? [])) changes.tags = merged;
  }
  if (Object.keys(c.customData).length > 0) {
    const merged = { ...(existing.customData ?? {}), ...c.customData };
    if (JSON.stringify(merged) !== JSON.stringify(existing.customData ?? {})) changes.customData = merged;
  }
  return changes;
}

async function contextOf(db: Executor, businessId: string): Promise<BusinessContext> {
  const ctx = await getBusinessContext(db, businessId);
  if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  return ctx;
}

/** Vista previa o importación (ver el encabezado del archivo). */
export async function importClients(db: Executor, businessId: string, options: ImportOptions): Promise<ImportReport> {
  const ctx = await contextOf(db, businessId);
  const country = ctx.business.country || DEFAULT_PHONE_COUNTRY;
  const customFields = await listCustomFields(db, businessId, { entity: "client" });
  const customByKey = new Map(customFields.map((f) => [f.key, f]));

  let parsed;
  try {
    parsed = parseCsv(options.csv, { maxRows: MAX_IMPORT_ROWS + 1, maxColumns: MAX_IMPORT_COLUMNS, maxCellLength: 10_000 });
  } catch (error) {
    if (error instanceof CsvError) throw new HttpError(400, error.message, "invalid_csv");
    throw error;
  }
  if (parsed.rows.length === 0) throw new HttpError(400, "El archivo está vacío.", "invalid_csv");

  const hasHeader = options.hasHeader ?? detectHeader(parsed.rows[0], customFields);
  const dataRows = hasHeader ? parsed.rows.slice(1) : parsed.rows;
  const dataLines = hasHeader ? parsed.lines.slice(1) : parsed.lines;
  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw new HttpError(400, `El archivo tiene más de ${MAX_IMPORT_ROWS} filas: dividilo en partes.`, "invalid_csv");
  }
  const columnCount = Math.max(...parsed.rows.map((r) => r.length));
  const headers = Array.from({ length: columnCount }, (_, i) => (hasHeader ? (parsed.rows[0][i] ?? "").trim() || null : null));
  const columns: ImportColumn[] = headers.map((header, index) => ({
    index,
    header,
    samples: dataRows
      .map((r) => (r[index] ?? "").trim())
      .filter(Boolean)
      .slice(0, 3),
  }));
  const mapping = options.mapping ? validateMapping(options.mapping, columnCount, customFields) : suggestMapping(headers, columnCount, customFields);

  const today = new Date().toISOString().slice(0, 10);
  const candidates = dataRows.map((cells, i) => readRow(cells, dataLines[i], mapping, country, customByKey, today));

  // Teléfono repetido dentro del archivo: error en la segunda aparición.
  const firstLineByPhone = new Map<string, number>();
  for (const c of candidates) {
    if (!c.phone) continue;
    const seen = firstLineByPhone.get(c.phone);
    if (seen !== undefined) c.errors.push(`Teléfono repetido en el archivo (ya está en la fila ${seen}).`);
    else firstLineByPhone.set(c.phone, c.line);
  }

  const onExisting = options.onExisting ?? "update";
  const phones = [...firstLineByPhone.keys()];

  const run = async (write: boolean): Promise<ImportRowResult[]> =>
    withTenant(db, businessId, async (tx) => {
      const byPhones = and(eq(clients.businessId, businessId), inArray(clients.phone, phones));
      const existingRows =
        phones.length === 0 ? [] : write ? await tx.select().from(clients).where(byPhones).for("update") : await tx.select().from(clients).where(byPhones);
      const existingByPhone = new Map(existingRows.map((r) => [r.phone as string, r]));
      const results: ImportRowResult[] = [];
      const inserts: NewClient[] = [];
      let updated = 0;
      for (const c of candidates) {
        const existing = c.phone ? existingByPhone.get(c.phone) : undefined;
        let action: ImportAction;
        if (c.errors.length > 0) action = "error";
        else if (existing) action = onExisting === "skip" ? "skip" : "update";
        else if (!c.name) {
          c.errors.push("Falta el nombre (un cliente nuevo lo necesita).");
          action = "error";
        } else action = "create";

        if (write && action === "create") {
          inserts.push({
            businessId,
            name: c.name as string,
            phone: c.phone,
            email: c.email,
            birthDate: c.birthDate,
            tags: c.tags,
            notes: c.notes,
            source: c.source ?? "Importación",
            customData: c.customData,
          });
        } else if (write && action === "update" && existing) {
          const changes = updateFor(existing, c);
          if (Object.keys(changes).length > 0) {
            await tx.update(clients).set(changes).where(and(eq(clients.businessId, businessId), eq(clients.id, existing.id)));
            updated++;
          }
        }
        results.push({ row: c.line, action, name: c.name ?? existing?.name ?? null, phone: c.phone, email: c.email, errors: c.errors });
      }
      if (write) {
        for (let i = 0; i < inserts.length; i += INSERT_CHUNK) await tx.insert(clients).values(inserts.slice(i, i + INSERT_CHUNK));
        const count = (a: ImportAction) => results.filter((r) => r.action === a).length;
        // Sin datos personales: solo conteos (src/platform/db/schema.ts, `audit_log`).
        await recordAudit(tx, businessId, "clients_imported", options.actor ?? "system", {
          created: count("create"),
          updated,
          skipped: count("skip"),
          errors: count("error"),
        });
      }
      return results;
    });

  let results: ImportRowResult[];
  try {
    results = await run(Boolean(options.commit));
  } catch (error) {
    if (isPhoneConflict(error)) {
      throw new HttpError(409, "Mientras importabas se cargó un cliente con uno de estos teléfonos. Volvé a intentar.", "import_conflict");
    }
    throw error;
  }

  const summary: Record<ImportAction, number> = { create: 0, update: 0, skip: 0, error: 0 };
  for (const r of results) summary[r.action]++;
  return {
    delimiter: parsed.delimiter,
    hasHeader,
    columns,
    mapping,
    fields: [
      ...IMPORT_FIELDS.map((id) => ({ id, label: FIELD_LABELS[id] })),
      ...customFields.map((f) => ({ id: `custom:${f.key}` as ImportField, label: f.label })),
    ],
    totalRows: results.length,
    summary,
    preview: results.slice(0, PREVIEW_ROWS),
    errors: results
      .filter((r) => r.action === "error")
      .slice(0, MAX_REPORTED_ERRORS)
      .map((r) => ({ row: r.row, messages: r.errors })),
    committed: Boolean(options.commit),
  };
}

function isPhoneConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let i = 0; current && i < 5; i++) {
    const e = current as { code?: string; constraint?: string; constraint_name?: string; message?: string; cause?: unknown };
    if (e.code === "23505" && [e.constraint, e.constraint_name, e.message].some((v) => String(v ?? "").includes("clients_business_phone_uq"))) return true;
    current = e.cause;
  }
  return false;
}
