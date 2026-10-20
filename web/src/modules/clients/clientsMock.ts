import type { TransportRequest, TransportResponse } from "../../lib/api";
import type { LocationRef, Role } from "../../lib/contract";
import { readStorage, writeStorage } from "../../lib/storage";
import type { ClientChannel, ClientDetail, ClientFormOptions, ClientSummary } from "./clientsApi";

// ─────────────────────────────────────────────────────────────────────────────
// Clientes en la API simulada (VITE_MOCK_API=1): mismas rutas, sobre, códigos y reglas que
// src/modules/clients (alta, ficha, búsqueda, "Ver más", teléfono único, permisos por rol y
// anonimización). Lo llama lib/mockApi.ts con la sesión ya resuelta. El estado vive en
// sessionStorage (cada pestaña o test arranca limpio). Datos ficticios.
//
// Simplificaciones: el cursor es un desplazamiento (el real es keyset) y el teléfono se
// normaliza solo para Costa Rica y Panamá (o con + y código de país).
// ─────────────────────────────────────────────────────────────────────────────

export interface MockClientsSession {
  businessId: string;
  role: Role;
  /** Todas las sucursales del negocio (no solo las del usuario). */
  locations: LocationRef[];
  country: string;
  /** Terminología del negocio para los mensajes ("paciente"). */
  clientTerm: string;
}

type MockClient = Omit<ClientDetail, "guardian" | "dependents">;

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
const BASE_DAY = Date.UTC(2026, 9, 15, 16, 0, 0);
const DAY_MS = 86_400_000;

function mockId(n: number): string {
  return `c1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function seedClients(businessId: string, locations: LocationRef[]): MockClient[] {
  const count = SEED_COUNT[businessId] ?? 0;
  const offset = businessId.endsWith("02") ? 500 : 0;
  const staff = STAFF[businessId] ?? [];
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1 + offset;
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    const visits = i % 5 === 4 ? 0 : (i * 3) % 11;
    const lastVisit = visits === 0 ? null : new Date(BASE_DAY - ((i * 13) % 150) * DAY_MS);
    const firstVisit = lastVisit ? new Date(lastVisit.getTime() - visits * 30 * DAY_MS) : null;
    const email = i % 3 === 0 ? `${first}.${last}`.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() + "@example.com" : null;
    const created = new Date(BASE_DAY - (200 - (i % 200)) * DAY_MS).toISOString();
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
      vip: false,
      marketingConsentAt: null,
      marketingOptOutAt: null,
      visitCount: visits,
      firstVisitAt: firstVisit?.toISOString() ?? null,
      lastVisitAt: lastVisit?.toISOString() ?? null,
      totalSpentCents: visits * 2_500_000,
      anonymized: false,
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

// ── Respuestas ──────────────────────────────────────────────────────────────

const ok = (data: unknown, status = 200): TransportResponse => ({ status, payload: { ok: true, data } });
const fail = (status: number, code: string, error: string, fields?: Record<string, string>): TransportResponse => ({
  status,
  payload: { ok: false, error, code, ...(fields ? { fields } : {}) },
});
const invalid = (fields: Record<string, string>) => fail(400, "validation_error", "Datos inválidos: revisá los campos marcados.", fields);
const forbiddenRole = () => fail(403, "forbidden_role", "No tenés permiso para esta acción.");

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

function summary(c: MockClient): ClientSummary {
  return { id: c.id, name: c.name, phone: c.phone, email: c.email, tags: c.tags, visitCount: c.visitCount, lastVisitAt: c.lastVisitAt };
}

function detail(c: MockClient, all: MockClient[]): ClientDetail {
  const guardian = c.guardianId ? all.find((x) => x.id === c.guardianId) : undefined;
  return {
    ...c,
    guardian: guardian ? { id: guardian.id, name: guardian.name } : null,
    dependents: all.filter((x) => x.guardianId === c.id).map((x) => ({ id: x.id, name: x.name })),
  };
}

/** Aplica y valida los cambios de un alta o PATCH. Devuelve los errores por campo (o el 409). */
function applyChanges(
  target: MockClient,
  body: unknown,
  all: MockClient[],
  session: MockClientsSession,
): TransportResponse | null {
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
  const tags = typeof body === "object" && body !== null ? (body as Record<string, unknown>).tags : undefined;
  if (Array.isArray(tags)) {
    const seen = new Set<string>();
    target.tags = tags.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()).filter((x) => {
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
  if (target.preferredChannel === "email" && !target.email && !fields["body.email"]) {
    fields["body.preferredChannel"] = "Para avisarle por correo, primero cargá su correo.";
  }
  return Object.keys(fields).length > 0 ? invalid(fields) : null;
}

const EDITORS: Role[] = ["owner", "admin", "front_desk"];

/** Rutas /clients* del mock. null si la ruta no es de clientes. */
export function routeClientsMock(req: TransportRequest, session: MockClientsSession): TransportResponse | null {
  const url = new URL(req.path, "http://mock");
  const path = url.pathname;
  if (path !== "/clients" && !path.startsWith("/clients/")) return null;

  const state = loadState();
  const all = (state[session.businessId] ??= seedClients(session.businessId, session.locations));
  const save = () => saveState(state);
  const notFound = () => fail(404, "not_found", `No encontramos ese ${session.clientTerm}.`);

  if (req.method === "GET" && path === "/clients") {
    const q = (url.searchParams.get("q") ?? "").trim();
    const sort = url.searchParams.get("sort") === "last_visit" ? "last_visit" : "name";
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 100);
    const offset = Number(url.searchParams.get("cursor") ?? 0) || 0;
    const terms = q.split(/\s+/).filter(Boolean).map(fold);
    const matches = all.filter((c) => {
      if (c.anonymized) return false;
      return terms.every((term) => {
        const d = digitsOf(term);
        return fold(c.name).includes(term) || (c.email ?? "").includes(term) || (d.length >= 3 && (c.phone ?? "").includes(d));
      });
    });
    const byName = (a: MockClient, b: MockClient) => fold(a.name).localeCompare(fold(b.name)) || a.id.localeCompare(b.id);
    matches.sort(
      sort === "name"
        ? byName
        : (a, b) => {
            if (a.lastVisitAt !== b.lastVisitAt) {
              if (!a.lastVisitAt) return 1;
              if (!b.lastVisitAt) return -1;
              return b.lastVisitAt.localeCompare(a.lastVisitAt);
            }
            return byName(a, b);
          },
    );
    const page = matches.slice(offset, offset + limit);
    const next = offset + limit < matches.length ? String(offset + limit) : null;
    return ok({ items: page.map(summary), nextCursor: next });
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
    if (!str(req.body, "name")?.trim()) return invalid({ "body.name": "Escribí el nombre." });
    const now = new Date().toISOString();
    const created: MockClient = {
      id: mockId(10_000 + all.length + Math.floor(Math.random() * 1000)),
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
      marketingConsentAt: null,
      marketingOptOutAt: null,
      visitCount: 0,
      firstVisitAt: null,
      lastVisitAt: null,
      totalSpentCents: 0,
      anonymized: false,
      createdAt: now,
      updatedAt: now,
    };
    const error = applyChanges(created, req.body, all, session);
    if (error) return error;
    all.push(created);
    save();
    return ok(detail(created, all), 201);
  }

  const match = /^\/clients\/([^/]+)(\/anonymize)?$/.exec(path);
  if (!match) return fail(404, "not_found", "Ruta inexistente en el mock.");
  const client = all.find((c) => c.id === decodeURIComponent(match[1]));
  const anonymize = Boolean(match[2]);

  if (req.method === "GET" && !anonymize) return client ? ok(detail(client, all)) : notFound();

  if (req.method === "PATCH" && !anonymize) {
    if (!EDITORS.includes(session.role)) return forbiddenRole();
    if (!client) return notFound();
    if (client.anonymized) return fail(409, "client_anonymized", `Los datos de este ${session.clientTerm} se eliminaron: ya no se puede editar.`);
    const draft: MockClient = { ...client };
    const error = applyChanges(draft, req.body, all, session);
    if (error) return error;
    Object.assign(client, draft, { updatedAt: new Date().toISOString() });
    save();
    return ok(detail(client, all));
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
      marketingConsentAt: null,
      marketingOptOutAt: null,
      anonymized: true,
      updatedAt: new Date().toISOString(),
    });
    save();
    return ok(detail(client, all));
  }

  return fail(405, "method_not_allowed", "Método no permitido.");
}
