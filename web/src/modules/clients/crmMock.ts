import type { TransportRequest, TransportResponse } from "../../lib/api";
import type { Role } from "../../lib/contract";
import { readStorage, writeStorage } from "../../lib/storage";
import type { ClientStatus } from "./clientsApi";
import type { ClientRulesView, ClientStatusRules, CustomField, CustomFieldEntity, CustomFieldType } from "./crmApi";

// ─────────────────────────────────────────────────────────────────────────────
// CRM de clientes en la API simulada (VITE_MOCK_API=1): reglas del estado
// (`/settings/client-rules`), campos personalizados (`/settings/custom-fields*`), el
// cálculo del estado, la validación de `customData` y el CSV (importar y exportar). Mismas
// reglas que src/modules/{business,clients} en versión simplificada; lo usa
// ./clientsMock.ts. El estado vive en sessionStorage. Datos ficticios.
// ─────────────────────────────────────────────────────────────────────────────

const STATE_KEY = "selyon.mock.crm";
const DAY_MS = 86_400_000;
const MIN_AT_RISK_DAYS = 7;

export const DEFAULT_RULES: ClientStatusRules = {
  newDays: 30,
  vipMinVisits: 10,
  vipMinSpentCents: null,
  atRiskMode: "fixed",
  atRiskAfterDays: 60,
  atRiskFrequencyFactor: 2,
  inactiveAfterDays: 120,
};

type FieldSeed = Pick<CustomField, "entity" | "key" | "label" | "type"> & { options?: string[] };

/** Espejo de las plantillas de rubro (src/modules/business/templates/*.json). */
const TEMPLATES: Record<string, { rules: Partial<ClientStatusRules>; fields: FieldSeed[] }> = {
  generic: { rules: {}, fields: [] },
  dental: {
    rules: { newDays: 90, vipMinVisits: 8, atRiskAfterDays: 210, inactiveAfterDays: 400 },
    fields: [
      { entity: "client", key: "allergies", label: "Alergias", type: "long_text" },
      { entity: "client", key: "current_medications", label: "Medicamentos actuales", type: "long_text" },
      { entity: "client", key: "health_insurance", label: "Seguro médico", type: "text" },
      { entity: "appointment", key: "tooth", label: "Pieza dental", type: "text" },
    ],
  },
  aesthetics: {
    rules: { newDays: 45, atRiskMode: "frequency", atRiskAfterDays: 60, inactiveAfterDays: 150 },
    fields: [
      { entity: "client", key: "skin_type", label: "Tipo de piel", type: "select", options: ["Seca", "Grasa", "Mixta", "Normal", "Sensible"] },
      { entity: "client", key: "allergies", label: "Alergias o sensibilidades", type: "long_text" },
    ],
  },
  nails: {
    rules: { vipMinVisits: 12, atRiskMode: "frequency", atRiskAfterDays: 45, inactiveAfterDays: 90 },
    fields: [
      { entity: "client", key: "preferred_shape", label: "Forma preferida", type: "select", options: ["Cuadrada", "Redonda", "Almendra", "Stiletto", "Coffin"] },
      { entity: "appointment", key: "design_notes", label: "Diseño o referencia", type: "long_text" },
    ],
  },
};

const templateOf = (industry: string) => TEMPLATES[industry] ?? TEMPLATES.generic;

interface BusinessCrm {
  rules: ClientStatusRules;
  fields: CustomField[];
  seq: number;
}

type State = Record<string, BusinessCrm>;

function load(): State {
  try {
    return JSON.parse(readStorage(STATE_KEY, "session") ?? "{}") as State;
  } catch {
    return {};
  }
}

function save(state: State): void {
  writeStorage(STATE_KEY, JSON.stringify(state), "session");
}

function fieldId(businessId: string, n: number): string {
  return `cf000000-0000-4000-8000-${businessId.slice(-4)}${String(n).padStart(8, "0")}`;
}

/** Lo del CRM de un negocio (lo siembra con la plantilla de su rubro). */
export function crmOf(businessId: string, industry: string): { data: BusinessCrm; persist: () => void } {
  const state = load();
  if (!state[businessId]) {
    const template = templateOf(industry);
    state[businessId] = {
      rules: { ...DEFAULT_RULES, ...template.rules },
      fields: template.fields.map((f, i) => ({
        id: fieldId(businessId, i + 1),
        entity: f.entity,
        key: f.key,
        label: f.label,
        type: f.type,
        options: f.options ?? [],
        required: false,
        position: i,
        active: true,
      })),
      seq: template.fields.length,
    };
    save(state);
  }
  return { data: state[businessId], persist: () => save(state) };
}

// ── Estado del cliente (espejo de src/modules/clients/status.ts) ────────────

export interface StatusInput {
  visitCount: number;
  firstVisitAt: string | null;
  lastVisitAt: string | null;
  totalSpentCents: number;
  vip: boolean;
  createdAt: string;
}

export function isVipBy(c: StatusInput, r: ClientStatusRules): boolean {
  return c.vip || (r.vipMinVisits !== null && c.visitCount >= r.vipMinVisits) || (r.vipMinSpentCents !== null && c.totalSpentCents >= r.vipMinSpentCents);
}

export function statusOf(c: StatusInput, r: ClientStatusRules, now = Date.now()): ClientStatus {
  const ref = Date.parse(c.lastVisitAt ?? c.createdAt);
  const age = now - ref;
  if (age > r.inactiveAfterDays * DAY_MS) return "inactive";
  let threshold = r.atRiskAfterDays * DAY_MS;
  if (r.atRiskMode === "frequency" && c.visitCount >= 2 && c.firstVisitAt && c.lastVisitAt) {
    const span = Date.parse(c.lastVisitAt) - Date.parse(c.firstVisitAt);
    threshold = Math.max((r.atRiskFrequencyFactor * span) / (c.visitCount - 1), MIN_AT_RISK_DAYS * DAY_MS);
  }
  if (age > threshold) return "at_risk";
  if (isVipBy(c, r)) return "vip";
  if (now - Date.parse(c.firstVisitAt ?? c.createdAt) <= r.newDays * DAY_MS) return "new";
  return "active";
}

// ── Respuestas ──────────────────────────────────────────────────────────────

export const ok = (data: unknown, status = 200): TransportResponse => ({ status, payload: { ok: true, data } });
export const fail = (status: number, code: string, error: string, fields?: Record<string, string>): TransportResponse => ({
  status,
  payload: { ok: false, error, code, ...(fields ? { fields } : {}) },
});
export const invalid = (fields: Record<string, string>) => fail(400, "validation_error", "Datos inválidos: revisá los campos marcados.", fields);
export const forbiddenRole = () => fail(403, "forbidden_role", "No tenés permiso para esta acción.");
export const notInPlan = () =>
  fail(403, "module_not_in_plan", "Esta función es del CRM de clientes del plan Pro. Para usarla, ampliá tu plan en Configuración › Plan.");

// ── Valores de los campos (espejo de applyCustomDataPatch) ──────────────────

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeValue(def: CustomField, raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (raw === null || raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0)) return { ok: true, value: undefined };
  switch (def.type) {
    case "text":
    case "long_text":
      return typeof raw === "string" ? { ok: true, value: raw.trim() } : { ok: false, error: "Se esperaba un texto." };
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? { ok: true, value: raw } : { ok: false, error: "Se esperaba un número." };
    case "date":
      return typeof raw === "string" && RE_DATE.test(raw) ? { ok: true, value: raw } : { ok: false, error: "Fecha inválida (formato AAAA-MM-DD)." };
    case "boolean":
      return typeof raw === "boolean" ? { ok: true, value: raw } : { ok: false, error: "Se esperaba sí o no." };
    case "select":
      return typeof raw === "string" && def.options.includes(raw) ? { ok: true, value: raw } : { ok: false, error: "Elegí una de las opciones." };
    case "multi_select":
      return Array.isArray(raw) && raw.every((v) => typeof v === "string" && def.options.includes(v))
        ? { ok: true, value: def.options.filter((o) => (raw as string[]).includes(o)) }
        : { ok: false, error: "Elegí entre las opciones." };
  }
}

export function applyCustomData(
  fields: CustomField[],
  entity: CustomFieldEntity,
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): { data: Record<string, unknown>; errors: Record<string, string> } {
  const active = new Map(fields.filter((f) => f.active && f.entity === entity).map((f) => [f.key, f]));
  const data = { ...current };
  const errors: Record<string, string> = {};
  for (const [key, raw] of Object.entries(patch)) {
    const def = active.get(key);
    if (!def) {
      errors[`body.customData.${key}`] = "Ese campo no existe o está desactivado.";
      continue;
    }
    const r = normalizeValue(def, raw);
    if (!r.ok) errors[`body.customData.${key}`] = r.error;
    else if (r.value === undefined) delete data[key];
    else data[key] = r.value;
  }
  for (const def of active.values()) {
    const v = data[def.key];
    const filled = v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
    if (def.required && !filled && !errors[`body.customData.${def.key}`]) errors[`body.customData.${def.key}`] = "Campo obligatorio.";
  }
  return { data, errors };
}

// ── Rutas de Configuración ──────────────────────────────────────────────────

export interface MockCrmSession {
  businessId: string;
  industry: string;
  role: Role;
  crm: boolean;
}

const MANAGERS: Role[] = ["owner", "admin"];
const TYPES: CustomFieldType[] = ["text", "long_text", "number", "date", "boolean", "select", "multi_select"];
const COMPATIBLE: Record<CustomFieldType, CustomFieldType[]> = {
  text: ["long_text"],
  long_text: ["text"],
  number: [],
  date: [],
  boolean: [],
  select: ["multi_select"],
  multi_select: [],
};
const hasOptions = (t: CustomFieldType) => t === "select" || t === "multi_select";

function keyFrom(label: string): string {
  const key = label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (/^[a-z]/.test(key) ? key : `campo_${key}`).slice(0, 40) || "campo";
}

function uniqueOptions(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const seen = new Set<string>();
  return options
    .filter((o): o is string => typeof o === "string")
    .map((o) => o.trim())
    .filter((o) => {
      const k = o.toLowerCase();
      if (!o || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

const obj = (body: unknown): Record<string, unknown> => (typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {});

/** `/settings/client-rules` y `/settings/custom-fields*`; null si la ruta no es suya. */
export function routeCrmSettingsMock(req: TransportRequest, session: MockCrmSession): TransportResponse | null {
  const url = new URL(req.path, "http://mock");
  const path = url.pathname;
  if (path !== "/settings/client-rules" && path !== "/settings/custom-fields" && !path.startsWith("/settings/custom-fields/")) return null;
  const manager = MANAGERS.includes(session.role);
  const { data, persist } = crmOf(session.businessId, session.industry);
  const body = obj(req.body);

  if (path === "/settings/client-rules") {
    if (!manager) return forbiddenRole();
    if (!session.crm) return notInPlan();
    const view = (): ClientRulesView => ({
      rules: data.rules,
      industryDefaults: { ...DEFAULT_RULES, ...templateOf(session.industry).rules },
      industry: session.industry,
    });
    if (req.method === "GET") return ok(view());
    if (req.method === "PUT") {
      const r = body as unknown as ClientStatusRules;
      const fields: Record<string, string> = {};
      const intIn = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
      if (!intIn(r.newDays, 1, 365)) fields["body.newDays"] = "Entre 1 y 365.";
      if (r.vipMinVisits !== null && !intIn(r.vipMinVisits, 1, 10_000)) fields["body.vipMinVisits"] = "Inválido.";
      if (r.vipMinSpentCents !== null && !intIn(r.vipMinSpentCents, 0, 1e12)) fields["body.vipMinSpentCents"] = "Inválido.";
      if (r.atRiskMode !== "fixed" && r.atRiskMode !== "frequency") fields["body.atRiskMode"] = "Inválido.";
      if (!intIn(r.atRiskAfterDays, 1, 3650)) fields["body.atRiskAfterDays"] = "Entre 1 y 3650.";
      if (typeof r.atRiskFrequencyFactor !== "number" || r.atRiskFrequencyFactor < 1 || r.atRiskFrequencyFactor > 10) fields["body.atRiskFrequencyFactor"] = "Entre 1 y 10.";
      if (!intIn(r.inactiveAfterDays, 1, 3650)) fields["body.inactiveAfterDays"] = "Entre 1 y 3650.";
      else if (r.inactiveAfterDays <= r.atRiskAfterDays) fields["body.inactiveAfterDays"] = "Los días para «inactivo» tienen que ser más que los de «en riesgo».";
      if (Object.keys(fields).length > 0) return invalid(fields);
      data.rules = {
        newDays: r.newDays,
        vipMinVisits: r.vipMinVisits,
        vipMinSpentCents: r.vipMinSpentCents,
        atRiskMode: r.atRiskMode,
        atRiskAfterDays: r.atRiskAfterDays,
        atRiskFrequencyFactor: Math.round(r.atRiskFrequencyFactor * 10) / 10,
        inactiveAfterDays: r.inactiveAfterDays,
      };
      persist();
      return ok(view());
    }
    return fail(405, "method_not_allowed", "Método no permitido.");
  }

  // Campos personalizados.
  if (req.method === "GET" && path === "/settings/custom-fields") {
    if (!session.crm) return notInPlan();
    const entity = url.searchParams.get("entity");
    const all = url.searchParams.get("includeInactive") === "1" && manager;
    return ok(
      data.fields
        .filter((f) => (!entity || f.entity === entity) && (all || f.active))
        .sort((a, b) => a.entity.localeCompare(b.entity) || a.position - b.position),
    );
  }
  if (!manager) return forbiddenRole();
  if (!session.crm) return notInPlan();

  if (req.method === "POST" && path === "/settings/custom-fields") {
    const entity = body.entity === "appointment" ? "appointment" : body.entity === "client" ? "client" : null;
    const label = typeof body.label === "string" ? body.label.trim() : "";
    const type = TYPES.includes(body.type as CustomFieldType) ? (body.type as CustomFieldType) : null;
    const options = uniqueOptions(body.options);
    const fields: Record<string, string> = {};
    if (!entity) fields["body.entity"] = "Inválido.";
    if (!label) fields["body.label"] = "Escribí el nombre del campo.";
    if (!type) fields["body.type"] = "Inválido.";
    if (type && hasOptions(type) && options.length < 2) fields["body.options"] = "Cargá al menos dos opciones.";
    if (entity && label && data.fields.some((f) => f.entity === entity && f.active && f.label.toLowerCase() === label.toLowerCase())) {
      fields["body.label"] = "Ya hay un campo con ese nombre.";
    }
    if (Object.keys(fields).length > 0 || !entity || !type) return invalid(fields);
    const taken = new Set(data.fields.filter((f) => f.entity === entity).map((f) => f.key));
    const baseKey = keyFrom(label);
    let key = baseKey;
    for (let n = 2; taken.has(key); n++) key = `${baseKey}_${n}`;
    data.seq += 1;
    const field: CustomField = {
      id: fieldId(session.businessId, data.seq),
      entity,
      key,
      label,
      type,
      options: hasOptions(type) ? options : [],
      required: body.required === true,
      position: data.fields.filter((f) => f.entity === entity).length,
      active: true,
    };
    data.fields.push(field);
    persist();
    return ok(field, 201);
  }

  if (req.method === "PUT" && path === "/settings/custom-fields/order") {
    const entity = body.entity as CustomFieldEntity;
    const ids = Array.isArray(body.ids) ? (body.ids as string[]) : [];
    const current = data.fields.filter((f) => f.entity === entity);
    if (ids.length !== current.length || !current.every((f) => ids.includes(f.id))) {
      return invalid({ "body.ids": "La lista tiene que traer todos los elementos actuales, una vez cada uno." });
    }
    ids.forEach((id, position) => {
      const f = data.fields.find((x) => x.id === id);
      if (f) f.position = position;
    });
    persist();
    return ok(current.sort((a, b) => a.position - b.position));
  }

  const match = /^\/settings\/custom-fields\/([^/]+)$/.exec(path);
  const field = match ? data.fields.find((f) => f.id === decodeURIComponent(match[1])) : undefined;
  if (!field) return fail(404, "not_found", "No encontramos ese campo.");

  if (req.method === "DELETE") {
    field.active = false;
    persist();
    return ok(field);
  }
  if (req.method === "PATCH") {
    const fields: Record<string, string> = {};
    const next = { ...field };
    if (typeof body.label === "string") {
      const label = body.label.trim();
      if (!label) fields["body.label"] = "Escribí el nombre del campo.";
      else if (data.fields.some((f) => f.id !== field.id && f.entity === field.entity && f.active && f.label.toLowerCase() === label.toLowerCase())) {
        fields["body.label"] = "Ya hay un campo activo con ese nombre.";
      } else next.label = label;
    }
    if (typeof body.type === "string" && body.type !== field.type) {
      if (!COMPATIBLE[field.type].includes(body.type as CustomFieldType)) fields["body.type"] = "Ese cambio de tipo podría romper lo ya cargado: creá un campo nuevo y desactivá este.";
      else next.type = body.type as CustomFieldType;
    }
    if (Array.isArray(body.options)) {
      const options = uniqueOptions(body.options);
      if (hasOptions(next.type) && options.length < 2) fields["body.options"] = "Cargá al menos dos opciones.";
      else next.options = hasOptions(next.type) ? options : [];
    }
    if (typeof body.required === "boolean") next.required = body.required;
    if (typeof body.active === "boolean") {
      if (body.active && !field.active && data.fields.some((f) => f.id !== field.id && f.entity === field.entity && f.active && f.label.toLowerCase() === next.label.toLowerCase())) {
        fields["body.active"] = "Ya hay un campo activo con ese nombre.";
      } else next.active = body.active;
    }
    if (Object.keys(fields).length > 0) return invalid(fields);
    Object.assign(field, next);
    persist();
    return ok(field);
  }
  return fail(405, "method_not_allowed", "Método no permitido.");
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** Parser CSV chico (comillas, BOM, `,` / `;` / tab), espejo de src/modules/clients/csv.ts. */
export function parseCsvText(input: string): { delimiter: string; rows: string[][]; lines: number[] } | { error: string } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? "";
  const count = (d: string) => firstLine.split(d).length - 1;
  const delimiter = [";", "\t"].reduce((best, d) => (count(d) > count(best) ? d : best), ",");
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const endRow = () => {
    row.push(cell);
    cell = "";
    if (row.some((c) => c.trim() !== "")) {
      rows.push(row);
      lines.push(rowLine);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === "\n") line++;
        cell += ch;
      }
    } else if (ch === '"' && cell.trim() === "") {
      cell = "";
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
      line++;
      rowLine = line;
    } else cell += ch;
  }
  if (quoted) return { error: `Hay una comilla sin cerrar (desde la fila ${line}).` };
  if (cell !== "" || row.length > 0) endRow();
  return { delimiter, rows, lines };
}

/** Celda CSV (comillas si hace falta, sin fórmulas). */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  const first = text.charAt(0);
  if (first === "=" || first === "@" || ((first === "+" || first === "-") && !/^[+-]?[\d\s().,-]+$/.test(text))) text = `'${text}`;
  return /[",;\r\n\t]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const csvLine = (values: unknown[]) => `${values.map(csvCell).join(",")}\r\n`;

/** Encabezados conocidos → campo (espejo de src/modules/clients/importer.ts). */
export const HEADER_SYNONYMS: Record<string, string[]> = {
  name: ["nombre completo", "nombre y apellidos", "cliente", "paciente", "name", "nombre"],
  first_name: ["nombres", "primer nombre", "first name"],
  last_name: ["apellidos", "apellido", "last name"],
  phone: ["telefono", "tel", "celular", "movil", "whatsapp", "numero", "phone", "mobile"],
  email: ["correo", "correo electronico", "email", "e-mail", "mail"],
  birth_date: ["fecha de nacimiento", "nacimiento", "cumpleanos", "birthday"],
  tags: ["etiquetas", "etiqueta", "tags"],
  notes: ["notas", "nota", "observaciones", "comentarios", "notes"],
  source: ["origen", "fuente", "source"],
};

export const IMPORT_FIELD_LABELS: Record<string, string> = {
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

export const foldHeader = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
