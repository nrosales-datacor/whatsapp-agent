import type { TransportRequest, TransportResponse } from "../../lib/api";
import type { LocationRef, Role } from "../../lib/contract";
import { readStorage, writeStorage } from "../../lib/storage";
import {
  CLIENT_STATUSES,
  type ClientChannel,
  type ClientDetail,
  type ClientFormOptions,
  type ClientStatus,
  type ClientStatusCounts,
  type ClientSummary,
  type ImportAction,
  type ImportReport,
} from "./clientsApi";
import type { CustomField } from "./crmApi";
import {
  applyCustomData,
  crmOf,
  csvLine,
  fail,
  foldHeader,
  forbiddenRole,
  HEADER_SYNONYMS,
  IMPORT_FIELD_LABELS,
  invalid,
  isVipBy,
  notInPlan,
  ok,
  parseCsvText,
  statusOf,
} from "./crmMock";

// ─────────────────────────────────────────────────────────────────────────────
// Clientes en la API simulada (VITE_MOCK_API=1): mismas rutas, sobre, códigos y reglas que
// src/modules/clients (alta, ficha, búsqueda, "Ver más", teléfono único, permisos por rol,
// anonimización y, en el Pro, el CRM: estado calculado, filtros, orden por gasto y visitas,
// chips, etiquetas, VIP, campos personalizados, importar y exportar CSV; "Mis clientes" del
// profesional). Lo llama lib/mockApi.ts con la sesión ya resuelta. El estado vive en
// sessionStorage (cada pestaña o test arranca limpio). Datos ficticios.
//
// Simplificaciones: el cursor es un desplazamiento (el real es keyset), el teléfono se
// normaliza solo para Costa Rica y Panamá (o con + y código de país) y la importación no
// valida los campos personalizados ni las fechas tan a fondo como el backend.
// ─────────────────────────────────────────────────────────────────────────────

export interface MockClientsSession {
  businessId: string;
  role: Role;
  /** Todas las sucursales del negocio (no solo las del usuario). */
  locations: LocationRef[];
  country: string;
  /** Terminología del negocio para los mensajes ("paciente"). */
  clientTerm: string;
  clientsTerm?: string;
  /** CRM completo (`me.plan.clientsTier = full`). */
  crm?: boolean;
  industry?: string;
  currency?: string;
  timezone?: string;
  /** Rol staff: ids de los clientes con citas suyas ("Mis clientes"); null = no tiene profesional vinculado. */
  staffClientIds?: string[] | null;
}

type MockClient = Omit<ClientDetail, "guardian" | "dependents" | "status" | "isVip">;

const STATE_KEY = "selyon.mock.clients";
const ANONYMIZED_NAME = "Cliente eliminado";

/** Profesionales por negocio (ids fijos) para "profesional preferido". */
const STAFF: Record<string, ClientFormOptions["staff"]> = {
  "5d0a1c7e-2f4b-4b8e-8f3a-6c1d2e3f4a01": [
    { id: "9a000000-0000-4000-8000-000000000001", name: "Dra. Paula Chaves", active: true },
    { id: "9a000000-0000-4000-8000-000000000002", name: "Dr. Esteban Ulate", active: true },
    { id: "9a000000-0000-4000-8000-000000000003", name: "Dra. Irene Brenes", active: false },
  ],
  "5d0a1c7e-2f4b-4b8e-8f3a-6c1d2e3f4a02": [
    { id: "9a000000-0000-4000-8000-000000000011", name: "Ana Rojas", active: true },
    { id: "9a000000-0000-4000-8000-000000000012", name: "Carla Méndez", active: true },
  ],
};

/** Cuántos clientes de ejemplo tiene cada negocio (Uñas Bella arranca vacío: estado vacío). */
const SEED_COUNT: Record<string, number> = {
  "5d0a1c7e-2f4b-4b8e-8f3a-6c1d2e3f4a01": 62,
  "5d0a1c7e-2f4b-4b8e-8f3a-6c1d2e3f4a02": 9,
};

const FIRST = ["María", "Laura", "Sofía", "Valeria", "Daniela", "Gabriela", "Andrea", "Paula", "Natalia", "Camila", "José", "Andrés", "Luis", "Ángel", "Diego", "Carlos", "Ignacio", "Ramón"];
const LAST = ["Fernández", "Jiménez", "Castro", "Solís", "Araya", "Mora", "Quesada", "Chaves", "Brenes", "Ulate", "Rojas", "Vargas", "Méndez", "Alvarado", "Zúñiga"];
const TAGS = [["Frecuente"], ["VIP"], [], ["Ortodoncia"], [], ["Referida"], [], []];
const DAY_MS = 86_400_000;

function mockId(n: number): string {
  return `c1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function seedClients(businessId: string, locations: LocationRef[]): MockClient[] {
  const count = SEED_COUNT[businessId] ?? 0;
  const offset = businessId.endsWith("02") ? 500 : 0;
  const staff = STAFF[businessId] ?? [];
  // Fechas relativas a HOY (a las 10:00 de Costa Rica): los estados salen variados siempre.
  const base = new Date();
  base.setUTCHours(16, 0, 0, 0);
  const baseDay = base.getTime();
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1 + offset;
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    const visits = i % 5 === 4 ? 0 : (i * 3) % 11;
    const lastVisit = visits === 0 ? null : new Date(baseDay - ((i * 37) % 480) * DAY_MS);
    const firstVisit = lastVisit ? new Date(lastVisit.getTime() - visits * 30 * DAY_MS) : null;
    const email = i % 3 === 0 ? `${first}.${last}`.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() + "@example.com" : null;
    const created = new Date((firstVisit?.getTime() ?? baseDay) - ((i * 11) % 200) * DAY_MS).toISOString();
    return {
      id: mockId(n),
      name: `${first} ${last}`,
      phone: i % 9 === 8 ? null : `+5066000${String(n).padStart(4, "0")}`,
      email,
      birthDate: i % 4 === 0 ? `19${70 + (i % 30)}-0${1 + (i % 9)}-1${i % 10}` : null,
      guardianId: null,
      notes: i % 6 === 0 ? "Prefiere citas en la tarde." : null,
      tags: TAGS[i % TAGS.length],
      source: i % 3 === 0 ? "Instagram" : i % 3 === 1 ? "WhatsApp" : null,
      preferredLocationId: locations.length > 0 && i % 2 === 0 ? locations[i % locations.length].id : null,
      preferredStaffId: staff.length > 0 && i % 4 === 1 ? staff[i % staff.length].id : null,
      preferredChannel: email && i % 2 === 0 ? ("email" as const) : i % 5 === 0 ? ("whatsapp" as const) : null,
      vip: i % 17 === 3,
      customData: {},
      marketingConsentAt: null,
      marketingOptOutAt: null,
      visitCount: visits,
      firstVisitAt: firstVisit?.toISOString() ?? null,
      lastVisitAt: lastVisit?.toISOString() ?? null,
      totalSpentCents: visits * 2_500_000,
      anonymized: false,
      anonymizedAt: null,
      createdAt: created,
      updatedAt: created,
    };
  });
}

type State = Record<string, MockClient[]>;

function loadState(): State {
  try {
    return JSON.parse(readStorage(STATE_KEY, "session") ?? "{}") as State;
  } catch {
    return {};
  }
}

function saveState(state: State): void {
  writeStorage(STATE_KEY, JSON.stringify(state), "session");
}

// ── Reglas (espejo simplificado del backend) ────────────────────────────────

const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const digitsOf = (text: string) => text.replace(/\D/g, "");
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CALLING: Record<string, { code: string; lengths: number[] }> = { CR: { code: "506", lengths: [8] }, PA: { code: "507", lengths: [7, 8] } };

function normalizePhone(input: string, country: string): string | null {
  const raw = input.trim();
  if (!/^\+?[\d\s().\-/]+$/.test(raw)) return null;
  const digits = digitsOf(raw);
  if (raw.startsWith("+")) return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
  const plan = CALLING[country];
  if (!plan) return null;
  if (plan.lengths.includes(digits.length)) return `+${plan.code}${digits}`;
  if (digits.startsWith(plan.code) && plan.lengths.includes(digits.length - plan.code.length)) return `+${digits}`;
  return null;
}

function str(body: unknown, key: string): string | null | undefined {
  if (typeof body !== "object" || body === null || !(key in body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

const blankToNull = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v.trim() === "" ? null : v.trim());
const bodyKey = (body: unknown, key: string): unknown => (typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined);

interface Crm {
  crm: boolean;
  rules: ReturnType<typeof crmOf>["data"]["rules"];
  fields: CustomField[];
}

function summary(c: MockClient, crm: Crm): ClientSummary {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    tags: c.tags,
    visitCount: c.visitCount,
    lastVisitAt: c.lastVisitAt,
    totalSpentCents: c.totalSpentCents,
    status: crm.crm ? statusOf(c, crm.rules) : null,
    isVip: crm.crm ? isVipBy(c, crm.rules) : null,
  };
}

function detail(c: MockClient, all: MockClient[], crm: Crm): ClientDetail {
  const guardian = c.guardianId ? all.find((x) => x.id === c.guardianId) : undefined;
  const withCrm = crm.crm && !c.anonymized;
  return {
    ...c,
    guardian: guardian ? { id: guardian.id, name: guardian.name } : null,
    dependents: all.filter((x) => x.guardianId === c.id).map((x) => ({ id: x.id, name: x.name })),
    status: withCrm ? statusOf(c, crm.rules) : null,
    isVip: withCrm ? isVipBy(c, crm.rules) : null,
  };
}

/** Aplica y valida los cambios de un alta o PATCH. Devuelve los errores por campo (o el 409). */
function applyChanges(target: MockClient, body: unknown, all: MockClient[], session: MockClientsSession, crm: Crm): TransportResponse | null {
  const fields: Record<string, string> = {};
  const name = str(body, "name");
  if (name !== undefined) {
    if (!name || !name.trim()) fields["body.name"] = "Escribí el nombre.";
    else target.name = name.trim();
  }
  const email = blankToNull(str(body, "email"));
  if (email !== undefined) {
    if (email && !RE_EMAIL.test(email)) fields["body.email"] = "Correo electrónico inválido.";
    else target.email = email ? email.toLowerCase() : null;
  }
  const birthDate = blankToNull(str(body, "birthDate"));
  if (birthDate !== undefined) {
    if (birthDate && (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || birthDate > new Date().toISOString().slice(0, 10))) {
      fields["body.birthDate"] = "La fecha no puede ser futura.";
    } else target.birthDate = birthDate;
  }
  const notes = str(body, "notes");
  if (notes !== undefined) target.notes = blankToNull(notes) ?? null;
  const tags = bodyKey(body, "tags");
  if (Array.isArray(tags)) {
    const seen = new Set<string>();
    target.tags = tags
      .filter((x): x is string => typeof x === "string" && x.trim() !== "")
      .map((x) => x.trim())
      .filter((x) => {
        const key = x.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
  const channel = blankToNull(str(body, "preferredChannel"));
  if (channel !== undefined) {
    if (channel && channel !== "whatsapp" && channel !== "email") fields["body.preferredChannel"] = "Canal inválido.";
    else target.preferredChannel = channel as ClientChannel | null;
  }
  const locationId = blankToNull(str(body, "preferredLocationId"));
  if (locationId !== undefined) {
    if (locationId && !session.locations.some((l) => l.id === locationId)) fields["body.preferredLocationId"] = "Esa sucursal no existe en el negocio.";
    else target.preferredLocationId = locationId;
  }
  const staffId = blankToNull(str(body, "preferredStaffId"));
  if (staffId !== undefined) {
    if (staffId && !(STAFF[session.businessId] ?? []).some((s) => s.id === staffId)) fields["body.preferredStaffId"] = "Ese profesional no existe en el negocio.";
    else target.preferredStaffId = staffId;
  }
  const guardianId = blankToNull(str(body, "guardianId"));
  if (guardianId !== undefined) {
    const guardian = guardianId ? all.find((x) => x.id === guardianId && !x.anonymized) : null;
    if (guardianId && guardianId === target.id) fields["body.guardianId"] = `Un ${session.clientTerm} no puede ser su propio responsable.`;
    else if (guardianId && !guardian) fields["body.guardianId"] = `Ese ${session.clientTerm} no existe en el negocio.`;
    else if (guardian?.guardianId) fields["body.guardianId"] = "El responsable no puede tener a su vez un responsable.";
    else if (guardian && all.some((x) => x.guardianId === target.id)) {
      fields["body.guardianId"] = `Este ${session.clientTerm} es responsable de otros: no puede tener un responsable.`;
    } else target.guardianId = guardianId;
  }
  const vip = bodyKey(body, "vip");
  if (typeof vip === "boolean") target.vip = vip;
  const customData = bodyKey(body, "customData");
  if (customData && typeof customData === "object") {
    const result = applyCustomData(crm.fields, "client", target.customData ?? {}, customData as Record<string, unknown>);
    Object.assign(fields, result.errors);
    if (Object.keys(result.errors).length === 0) target.customData = result.data;
  }
  const phone = blankToNull(str(body, "phone"));
  if (phone !== undefined) {
    const e164 = phone === null ? null : normalizePhone(phone, session.country);
    if (phone !== null && !e164) fields["body.phone"] = "Número de teléfono inválido. Si es de otro país, empezá con + y el código del país.";
    else {
      const other = e164 ? all.find((x) => x.phone === e164 && x.id !== target.id) : undefined;
      if (other) return fail(409, "phone_taken", `Ya hay un ${session.clientTerm} con ese teléfono (${other.name}).`);
      target.phone = e164;
    }
  }
  if (target.preferredChannel === "email" && !target.email && !fields["body.preferredChannel"] && !fields["body.email"]) {
    fields["body.preferredChannel"] = "Para avisarle por correo, primero cargá su correo.";
  }
  return Object.keys(fields).length > 0 ? invalid(fields) : null;
}

const EDITORS: Role[] = ["owner", "admin", "front_desk"];
const MANAGERS: Role[] = ["owner", "admin"];

/** Clientes del negocio en el mock (los siembra si hace falta). Lo usa la Agenda simulada. */
export function mockClientsOf(businessId: string, locations: LocationRef[]): Array<{ id: string; name: string; phone: string | null; email: string | null; anonymized: boolean }> {
  const state = loadState();
  if (!state[businessId]) {
    state[businessId] = seedClients(businessId, locations);
    saveState(state);
  }
  return state[businessId].map((c) => ({ id: c.id, name: c.name, phone: c.phone, email: c.email, anonymized: c.anonymized }));
}

/** Un cliente en riesgo, como lo lista el Inicio completo. */
export interface MockAtRiskClient {
  id: string;
  name: string;
  lastVisitAt: string | null;
  visitCount: number;
}

/**
 * Estado de la cartera para Reportes e Inicio completo (I5): cantidad por estado y los
 * clientes en riesgo, con las MISMAS reglas que los chips y el filtro «En riesgo» de la
 * lista (espejo de `countClientsByStatus` y `listClientsAtRisk`). Sin anonimizados; los
 * en riesgo, los que llevan más tiempo sin venir primero (los más cerca de pasar a inactivos).
 */
export function mockClientStatusOverview(
  businessId: string,
  locations: LocationRef[],
  industry: string,
  atRiskLimit = 5,
): { counts: ClientStatusCounts; atRisk: { count: number; items: MockAtRiskClient[] } } {
  const state = loadState();
  if (!state[businessId]) {
    state[businessId] = seedClients(businessId, locations);
    saveState(state);
  }
  const rules = crmOf(businessId, industry).data.rules;
  const now = Date.now();
  const counts = Object.fromEntries(CLIENT_STATUSES.map((s) => [s, 0])) as ClientStatusCounts;
  counts.total = 0;
  const atRisk: MockClient[] = [];
  for (const c of state[businessId]) {
    if (c.anonymized) continue;
    const status = statusOf(c, rules, now);
    counts[status]++;
    counts.total++;
    if (status === "at_risk") atRisk.push(c);
  }
  const reference = (c: MockClient) => Date.parse(c.lastVisitAt ?? c.createdAt);
  atRisk.sort((a, b) => reference(a) - reference(b) || b.visitCount - a.visitCount || a.id.localeCompare(b.id));
  return {
    counts,
    atRisk: {
      count: atRisk.length,
      items: atRisk.slice(0, atRiskLimit).map((c) => ({ id: c.id, name: c.name, lastVisitAt: c.lastVisitAt, visitCount: c.visitCount })),
    },
  };
}

// ── Filtros ─────────────────────────────────────────────────────────────────

const SORTS = ["name", "last_visit", "total_spent", "visit_count"];
const BASIC_SORTS = ["name", "last_visit"];
const isStatus = (v: string): v is ClientStatus => (CLIENT_STATUSES as readonly string[]).includes(v);

interface Filters {
  q: string;
  statuses: ClientStatus[];
  tags: string[];
  from: string;
  to: string;
  staff: string;
  location: string;
  vip: string;
}

function readFilters(url: URL): Filters {
  const p = url.searchParams;
  return {
    q: (p.get("q") ?? "").trim(),
    statuses: (p.get("status") ?? "").split(",").filter(isStatus),
    tags: p.getAll("tag"),
    from: p.get("lastVisitFrom") ?? "",
    to: p.get("lastVisitTo") ?? "",
    staff: p.get("preferredStaffId") ?? "",
    location: p.get("preferredLocationId") ?? "",
    vip: p.get("vip") ?? "",
  };
}

const usesCrm = (f: Filters, sort: string) =>
  f.statuses.length > 0 || f.tags.length > 0 || Boolean(f.from || f.to || f.staff || f.location || f.vip) || !BASIC_SORTS.includes(sort);

function localDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

function matches(c: MockClient, f: Filters, crm: Crm, tz: string, withStatus = true): boolean {
  if (c.anonymized) return false;
  const terms = f.q.split(/\s+/).filter(Boolean).map(fold);
  const textOk = terms.every((term) => {
    const d = digitsOf(term);
    return fold(c.name).includes(term) || (c.email ?? "").includes(term) || (d.length >= 3 && (c.phone ?? "").includes(d));
  });
  if (!textOk) return false;
  if (withStatus && f.statuses.length > 0 && !f.statuses.includes(statusOf(c, crm.rules))) return false;
  if (f.tags.length > 0 && !c.tags.some((t) => f.tags.includes(t))) return false;
  if (f.from || f.to) {
    if (!c.lastVisitAt) return false;
    const day = localDate(c.lastVisitAt, tz);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
  }
  if (f.staff && c.preferredStaffId !== f.staff) return false;
  if (f.location && c.preferredLocationId !== f.location) return false;
  if (f.vip === "true" && !isVipBy(c, crm.rules)) return false;
  if (f.vip === "false" && isVipBy(c, crm.rules)) return false;
  return true;
}

const byName = (a: MockClient, b: MockClient) => fold(a.name).localeCompare(fold(b.name)) || a.id.localeCompare(b.id);

function sorter(sort: string) {
  if (sort === "total_spent") return (a: MockClient, b: MockClient) => b.totalSpentCents - a.totalSpentCents || byName(a, b);
  if (sort === "visit_count") return (a: MockClient, b: MockClient) => b.visitCount - a.visitCount || byName(a, b);
  if (sort === "last_visit") {
    return (a: MockClient, b: MockClient) => {
      if (a.lastVisitAt !== b.lastVisitAt) {
        if (!a.lastVisitAt) return 1;
        if (!b.lastVisitAt) return -1;
        return b.lastVisitAt.localeCompare(a.lastVisitAt);
      }
      return byName(a, b);
    };
  }
  return byName;
}

// ── Importar y exportar ─────────────────────────────────────────────────────

const STATUS_LABELS: Record<ClientStatus, string> = { new: "Nuevo", active: "Activo", vip: "VIP", at_risk: "En riesgo", inactive: "Inactivo" };

function exportCsv(list: MockClient[], session: MockClientsSession, crm: Crm): string {
  const fields = crm.fields.filter((f) => f.entity === "client" && f.active).sort((a, b) => a.position - b.position);
  const staff = STAFF[session.businessId] ?? [];
  const tz = session.timezone ?? "America/Costa_Rica";
  let out = "﻿" + csvLine(["Nombre", "Teléfono", "Correo", "Fecha de nacimiento", "Etiquetas", "Origen", "Notas", "Profesional preferido", "VIP", "Estado", "Visitas", "Última visita", `Gasto total (${session.currency ?? "CRC"})`, ...fields.map((f) => f.label)]);
  for (const c of list) {
    out += csvLine([
      c.name,
      c.phone,
      c.email,
      c.birthDate,
      c.tags.join("; "),
      c.source,
      c.notes,
      staff.find((s) => s.id === c.preferredStaffId)?.name ?? "",
      isVipBy(c, crm.rules) ? "Sí" : "No",
      STATUS_LABELS[statusOf(c, crm.rules)],
      c.visitCount,
      c.lastVisitAt ? localDate(c.lastVisitAt, tz) : "",
      (c.totalSpentCents / 100).toFixed(2),
      ...fields.map((f) => {
        const v = c.customData?.[f.key];
        return v === undefined || v === null ? "" : typeof v === "boolean" ? (v ? "Sí" : "No") : Array.isArray(v) ? v.join("; ") : String(v);
      }),
    ]);
  }
  return out;
}

function importCsv(body: unknown, all: MockClient[], session: MockClientsSession, crm: Crm): { response: TransportResponse; created: MockClient[]; updated: MockClient[] } {
  const none = (response: TransportResponse) => ({ response, created: [], updated: [] });
  const csv = str(body, "csv") ?? "";
  if (!csv.trim()) return none(invalid({ "body.csv": "Subí un archivo." }));
  const parsed = parseCsvText(csv);
  if ("error" in parsed) return none(fail(400, "invalid_csv", parsed.error));
  if (parsed.rows.length === 0) return none(fail(400, "invalid_csv", "El archivo está vacío."));
  const fields = crm.fields.filter((f) => f.entity === "client" && f.active);
  const suggest = (header: string): string | null => {
    const h = foldHeader(header);
    const custom = fields.find((f) => foldHeader(f.label) === h);
    if (custom) return `custom:${custom.key}`;
    for (const [field, names] of Object.entries(HEADER_SYNONYMS)) if (names.includes(h)) return field;
    return null;
  };
  const looksLikeData = (cell: string) => RE_EMAIL.test(cell.trim()) || /^\+?[\d\s().-]{7,}$/.test(cell.trim());
  const hasHeaderInput = bodyKey(body, "hasHeader");
  const hasHeader = typeof hasHeaderInput === "boolean" ? hasHeaderInput : !parsed.rows[0].some(looksLikeData) && parsed.rows[0].some((c) => suggest(c) !== null);
  const rows = hasHeader ? parsed.rows.slice(1) : parsed.rows;
  const lines = hasHeader ? parsed.lines.slice(1) : parsed.lines;
  const columnCount = Math.max(...parsed.rows.map((r) => r.length));
  const headers = Array.from({ length: columnCount }, (_, i) => (hasHeader ? parsed.rows[0][i]?.trim() || null : null));
  const rawMapping = bodyKey(body, "mapping") as Record<string, string | null> | null | undefined;
  const mapping: Record<string, string | null> = {};
  if (rawMapping) {
    const used = new Set<string>();
    const errors: Record<string, string> = {};
    for (const [col, field] of Object.entries(rawMapping)) {
      if (Number(col) >= columnCount) errors[`body.mapping.${col}`] = "Esa columna no existe en el archivo.";
      else if (field && used.has(field)) errors[`body.mapping.${col}`] = "Ese campo ya está asignado a otra columna.";
      else {
        mapping[col] = field || null;
        if (field) used.add(field);
      }
    }
    if (Object.keys(errors).length > 0) return none(invalid(errors));
    if (!used.has("name") && !used.has("first_name") && !used.has("phone")) {
      return none(fail(400, "import_mapping_incomplete", "Asigná al menos la columna del nombre o la del teléfono."));
    }
  } else {
    const used = new Set<string>();
    headers.forEach((h, i) => {
      const field = h ? suggest(h) : null;
      mapping[String(i)] = field && !used.has(field) ? field : null;
      if (field) used.add(field);
    });
    if (used.has("last_name")) for (const [col, field] of Object.entries(mapping)) if (field === "name") mapping[col] = "first_name";
  }
  const onExisting = bodyKey(body, "onExisting") === "skip" ? "skip" : "update";
  const commit = bodyKey(body, "commit") === true;
  const seenPhones = new Map<string, number>();
  const results: ImportReport["preview"] = [];
  const created: MockClient[] = [];
  const updated: MockClient[] = [];
  rows.forEach((cells, i) => {
    const errors: string[] = [];
    const get = (field: string) => {
      const col = Object.entries(mapping).find(([, f]) => f === field)?.[0];
      return col === undefined ? "" : (cells[Number(col)] ?? "").trim().replace(/^'(?=[=+\-@])/, "");
    };
    const name = get("name") || `${get("first_name")} ${get("last_name")}`.trim() || null;
    const rawPhone = get("phone");
    const phone = rawPhone ? normalizePhone(rawPhone, session.country) : null;
    if (rawPhone && !phone) errors.push(`Teléfono inválido: «${rawPhone}».`);
    const email = get("email");
    if (email && !RE_EMAIL.test(email)) errors.push(`Correo inválido: «${email}».`);
    if (phone) {
      const seen = seenPhones.get(phone);
      if (seen !== undefined) errors.push(`Teléfono repetido en el archivo (ya está en la fila ${seen}).`);
      else seenPhones.set(phone, lines[i]);
    }
    const customData: Record<string, unknown> = {};
    for (const f of fields) {
      const v = get(`custom:${f.key}`);
      if (!v) continue;
      if (f.type === "select") {
        const option = f.options.find((o) => fold(o) === fold(v));
        if (option) customData[f.key] = option;
        else errors.push(`${f.label}: «${v}» no es una de las opciones.`);
      } else customData[f.key] = v;
    }
    const existing = phone ? all.find((c) => c.phone === phone) : undefined;
    let action: ImportAction = errors.length > 0 ? "error" : existing ? (onExisting === "skip" ? "skip" : "update") : name ? "create" : "error";
    if (action === "error" && errors.length === 0) errors.push("Falta el nombre (un cliente nuevo lo necesita).");
    if (commit && action === "create") {
      const now = new Date().toISOString();
      created.push({
        ...emptyClient(mockId(20_000 + all.length + created.length + Math.floor(Math.random() * 1000)), now),
        name: name as string,
        phone,
        email: email ? email.toLowerCase() : null,
        tags: get("tags") ? get("tags").split(/[;,|]/).map((t) => t.trim()).filter(Boolean) : [],
        notes: get("notes") || null,
        source: get("source") || "Importación",
        customData,
      });
    } else if (commit && action === "update" && existing) {
      if (name) existing.name = name;
      if (email) existing.email = email.toLowerCase();
      const tags = get("tags") ? get("tags").split(/[;,|]/).map((t) => t.trim()).filter(Boolean) : [];
      existing.tags = [...new Set([...existing.tags, ...tags])];
      existing.customData = { ...existing.customData, ...customData };
      existing.updatedAt = new Date().toISOString();
      updated.push(existing);
    }
    if (action === "error" && !errors.length) action = "error";
    results.push({ row: lines[i], action, name: name ?? existing?.name ?? null, phone, email: email || null, errors });
  });
  const count = (a: ImportAction) => results.filter((r) => r.action === a).length;
  const report: ImportReport = {
    delimiter: parsed.delimiter,
    hasHeader,
    columns: headers.map((header, index) => ({ index, header, samples: rows.map((r) => (r[index] ?? "").trim()).filter(Boolean).slice(0, 3) })),
    mapping,
    fields: [...Object.entries(IMPORT_FIELD_LABELS).map(([id, label]) => ({ id, label })), ...fields.map((f) => ({ id: `custom:${f.key}`, label: f.label }))],
    totalRows: results.length,
    summary: { create: count("create"), update: count("update"), skip: count("skip"), error: count("error") },
    preview: results.slice(0, 20),
    errors: results.filter((r) => r.action === "error").map((r) => ({ row: r.row, messages: r.errors })),
    committed: commit,
  };
  return { response: ok(report), created, updated };
}

function emptyClient(id: string, now: string): MockClient {
  return {
    id,
    name: "",
    phone: null,
    email: null,
    birthDate: null,
    guardianId: null,
    notes: null,
    tags: [],
    source: null,
    preferredLocationId: null,
    preferredStaffId: null,
    preferredChannel: null,
    vip: false,
    customData: {},
    marketingConsentAt: null,
    marketingOptOutAt: null,
    visitCount: 0,
    firstVisitAt: null,
    lastVisitAt: null,
    totalSpentCents: 0,
    anonymized: false,
    anonymizedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ── Rutas ───────────────────────────────────────────────────────────────────

/** Rutas /clients* del mock. null si la ruta no es de clientes. */
export function routeClientsMock(req: TransportRequest, session: MockClientsSession): TransportResponse | null {
  const url = new URL(req.path, "http://mock");
  const path = url.pathname;
  if (path !== "/clients" && !path.startsWith("/clients/")) return null;

  const state = loadState();
  const all = (state[session.businessId] ??= seedClients(session.businessId, session.locations));
  const save = () => saveState(state);
  const notFound = () => fail(404, "not_found", `No encontramos ese ${session.clientTerm}.`);
  const crmData = crmOf(session.businessId, session.industry ?? "generic").data;
  const crm: Crm = { crm: Boolean(session.crm), rules: crmData.rules, fields: crmData.fields };
  const tz = session.timezone ?? "America/Costa_Rica";
  // "Mis clientes": el profesional solo ve los que tienen citas suyas.
  const visible = (c: MockClient) => session.role !== "staff" || (session.staffClientIds ?? []).includes(c.id);

  if (req.method === "GET" && path === "/clients") {
    const filters = readFilters(url);
    const rawSort = url.searchParams.get("sort") ?? "name";
    const sort = SORTS.includes(rawSort) ? rawSort : "name";
    if (!crm.crm && usesCrm(filters, sort)) return notInPlan();
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 100);
    const offset = Number(url.searchParams.get("cursor") ?? 0) || 0;
    const list = all.filter((c) => visible(c) && matches(c, filters, crm, tz)).sort(sorter(sort));
    const page = list.slice(offset, offset + limit);
    return ok({ items: page.map((c) => summary(c, crm)), nextCursor: offset + limit < list.length ? String(offset + limit) : null });
  }

  if (req.method === "GET" && path === "/clients/status-counts") {
    if (!crm.crm) return notInPlan();
    const filters = readFilters(url);
    const counts = Object.fromEntries(CLIENT_STATUSES.map((s) => [s, 0])) as Record<ClientStatus, number> & { total: number };
    counts.total = 0;
    for (const c of all) {
      if (!visible(c) || !matches(c, filters, crm, tz, false)) continue;
      counts[statusOf(c, crm.rules)]++;
      counts.total++;
    }
    return ok(counts);
  }

  if (req.method === "GET" && path === "/clients/tags") {
    if (!crm.crm) return notInPlan();
    const counts = new Map<string, number>();
    for (const c of all) if (visible(c) && !c.anonymized) for (const t of c.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return ok([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].toLowerCase().localeCompare(b[0].toLowerCase())).map(([tag, count]) => ({ tag, count })));
  }

  if (req.method === "GET" && path === "/clients/export.csv") {
    if (!MANAGERS.includes(session.role)) return forbiddenRole();
    if (!crm.crm) return notInPlan();
    const list = all.filter((c) => matches(c, readFilters(url), crm, tz)).sort(byName);
    const day = new Date().toISOString().slice(0, 10);
    const base = fold(session.clientsTerm ?? "clientes").replace(/[^a-z0-9]+/g, "-") || "clientes";
    return ok({ filename: `${base}-${day}.csv`, content: exportCsv(list, session, crm) });
  }

  if (req.method === "POST" && path === "/clients/import") {
    if (!MANAGERS.includes(session.role)) return forbiddenRole();
    if (!crm.crm) return notInPlan();
    const { response, created } = importCsv(req.body, all, session, crm);
    if (created.length > 0 || (response.payload as { data?: ImportReport }).data?.committed) {
      all.push(...created);
      save();
    }
    return response;
  }

  if (req.method === "GET" && path === "/clients/form-options") {
    const options: ClientFormOptions = {
      locations: session.locations.map((l) => ({ id: l.id, name: l.name, active: true })),
      staff: STAFF[session.businessId] ?? [],
    };
    return ok(options);
  }

  if (req.method === "POST" && path === "/clients") {
    if (!EDITORS.includes(session.role)) return forbiddenRole();
    if (!crm.crm && (bodyKey(req.body, "vip") !== undefined || bodyKey(req.body, "customData") !== undefined)) return notInPlan();
    if (!str(req.body, "name")?.trim()) return invalid({ "body.name": "Escribí el nombre." });
    const now = new Date().toISOString();
    const created = emptyClient(mockId(10_000 + all.length + Math.floor(Math.random() * 1000)), now);
    const error = applyChanges(created, req.body, all, session, crm);
    if (error) return error;
    all.push(created);
    save();
    return ok(detail(created, all, crm), 201);
  }

  const match = /^\/clients\/([^/]+)(\/anonymize)?$/.exec(path);
  if (!match) return fail(404, "not_found", "Ruta inexistente en el mock.");
  const client = all.find((c) => c.id === decodeURIComponent(match[1]));
  const anonymize = Boolean(match[2]);

  if (req.method === "GET" && !anonymize) return client && visible(client) ? ok(detail(client, all, crm)) : notFound();

  if (req.method === "PATCH" && !anonymize) {
    if (!EDITORS.includes(session.role)) return forbiddenRole();
    if (!crm.crm && (bodyKey(req.body, "vip") !== undefined || bodyKey(req.body, "customData") !== undefined)) return notInPlan();
    if (!client) return notFound();
    if (client.anonymized) return fail(409, "client_anonymized", `Los datos de este ${session.clientTerm} se eliminaron: ya no se puede editar.`);
    const draft: MockClient = { ...client };
    const error = applyChanges(draft, req.body, all, session, crm);
    if (error) return error;
    Object.assign(client, draft, { updatedAt: new Date().toISOString() });
    save();
    return ok(detail(client, all, crm));
  }

  if (req.method === "POST" && anonymize) {
    if (session.role !== "owner") return forbiddenRole();
    if (!client) return notFound();
    if (client.anonymized) return fail(409, "client_anonymized", `Los datos de este ${session.clientTerm} ya se eliminaron.`);
    const confirmation = str(req.body, "confirmation") ?? "";
    const confirmed = client.phone
      ? normalizePhone(confirmation, session.country) === client.phone
      : confirmation.trim().toLowerCase() === client.name.trim().toLowerCase();
    if (!confirmed) return invalid({ "body.confirmation": client.phone ? "El teléfono no coincide." : "El nombre no coincide." });
    for (const dependent of all.filter((x) => x.guardianId === client.id)) dependent.guardianId = null;
    const now = new Date().toISOString();
    Object.assign(client, {
      name: ANONYMIZED_NAME,
      phone: null,
      email: null,
      birthDate: null,
      guardianId: null,
      notes: null,
      tags: [],
      source: null,
      preferredLocationId: null,
      preferredStaffId: null,
      preferredChannel: null,
      vip: false,
      customData: {},
      marketingConsentAt: null,
      marketingOptOutAt: null,
      anonymized: true,
      anonymizedAt: now,
      updatedAt: now,
    });
    save();
    return ok(detail(client, all, crm));
  }

  return fail(405, "method_not_allowed", "Método no permitido.");
}
