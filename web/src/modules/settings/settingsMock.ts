import type { TransportRequest, TransportResponse } from "../../lib/api";
import type { Branding } from "../../lib/branding";
import { DEFAULT_TERMINOLOGY, type LocationRef, type Role, type Terminology } from "../../lib/contract";
import { readStorage, writeStorage } from "../../lib/storage";
import type {
  BusinessSettings,
  CategoryView,
  LocationView,
  Member,
  ReminderChannel,
  ServiceView,
  StaffServiceItem,
  StaffView,
  TimeOffEntry,
  WeeklyBlock,
} from "./settingsApi";

// ─────────────────────────────────────────────────────────────────────────────
// API simulada de Configuración (modo mock, VITE_MOCK_API=1): mismas rutas, sobre y
// códigos que el backend (src/modules/{business,catalog,team}), con datos ficticios por
// negocio que se siembran la primera vez y viven en sessionStorage. La llama
// lib/mockApi.ts con la sesión simulada; `settingsOverlay` le devuelve lo que cambió del
// negocio (nombre, terminología, sucursales…) para que `me` lo refleje.
//
// Simplificaciones: no hay historial real (las sucursales y profesionales sembrados se
// marcan "con historial": eliminarlos los desactiva) y cambiar el rol de un usuario no
// cambia con qué rol entra esa cuenta en el mock.
// ─────────────────────────────────────────────────────────────────────────────

export interface MockSession {
  userId: string;
  businessId: string;
  role: Role;
  /** Sin valor = todas las sucursales. */
  locationIds?: string[];
}

export interface MockBusinessSeed {
  id: string;
  name: string;
  slug: string;
  plan: string;
  industry: string;
  currency: string;
  timezone: string;
  country: string;
  terminology: Partial<Terminology>;
  branding: Branding;
  locations: LocationRef[];
}

export interface MockMemberSeed {
  userId: string;
  name: string;
  email: string;
  role: Role;
  locationIds?: string[];
  totpEnabled: boolean;
  mustChangePassword: boolean;
}

interface WithHistory {
  /** Sembrado "con historial": eliminarlo lo desactiva (como haría la base con citas). */
  history?: boolean;
}

interface BizState {
  settings: Omit<BusinessSettings, "terminology" | "legal" | "updatedAt"> & {
    terminology: Partial<Terminology>;
    legal: NonNullable<BusinessSettings["legal"]>;
    version: number;
  };
  locations: (LocationView & WithHistory)[];
  categories: CategoryView[];
  services: ServiceView[];
  staff: (Omit<StaffView, "member" | "hours"> & WithHistory)[];
  staffHours: { staffId: string; locationId: string; weekday: number; start: string; end: string }[];
  staffServices: Record<string, StaffServiceItem[]>;
  timeOff: TimeOffEntry[];
  members: Member[];
}

interface State {
  seq: number;
  businesses: Record<string, BizState>;
}

const STATE_KEY = "selyon.mock.settings";
const MANAGERS: readonly Role[] = ["owner", "admin"];

function loadState(): State {
  const raw = readStorage(STATE_KEY, "session");
  if (raw) {
    try {
      return JSON.parse(raw) as State;
    } catch {
      // estado roto: se arranca de cero
    }
  }
  return { seq: 1000, businesses: {} };
}

function saveState(state: State): void {
  writeStorage(STATE_KEY, JSON.stringify(state), "session");
}

function nextId(state: State): string {
  state.seq += 1;
  return `00000000-0000-4000-9000-${String(state.seq).padStart(12, "0")}`;
}

// ── Siembra ─────────────────────────────────────────────────────────────────

const weekdays = (from: number, to: number, start: string, end: string): WeeklyBlock[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ weekday: from + i, start, end }));

type CatalogSeed = { name: string; services: [string, number, number, number, boolean?][] }[];

const CATALOG_SEEDS: Record<string, CatalogSeed> = {
  dental: [
    { name: "Diagnóstico y prevención", services: [["Valoración inicial", 30, 10, 2_000_000], ["Limpieza dental", 45, 15, 3_500_000]] },
    { name: "Restauración", services: [["Resina (calza)", 60, 15, 4_000_000, true]] },
    { name: "Estética dental", services: [["Blanqueamiento", 60, 15, 12_000_000]] },
  ],
  aesthetics: [
    { name: "Faciales", services: [["Limpieza facial profunda", 60, 10, 2_500_000], ["Hidratación facial", 45, 5, 1_800_000]] },
    { name: "Corporales", services: [["Masaje relajante", 60, 10, 2_200_000]] },
  ],
  nails: [
    { name: "Manos", services: [["Manicura semipermanente", 60, 5, 2_500]] },
    { name: "Pies", services: [["Pedicura spa", 60, 5, 3_000, true]] },
  ],
};

const STAFF_SEEDS: Record<string, { name: string; color: string; email?: string; days: [number, number]; ranges: [string, string][] }[]> = {
  dental: [
    { name: "Dra. Carmen Ruiz", color: "#0b7d72", days: [1, 5], ranges: [["08:00", "12:00"], ["13:00", "17:00"]] },
    { name: "Dr. Carlos Rojas", color: "#6a8ee8", email: "profesional@demo.test", days: [2, 6], ranges: [["09:00", "17:00"]] },
  ],
  aesthetics: [{ name: "Ana Rojas", color: "#e86a92", days: [1, 6], ranges: [["09:00", "18:00"]] }],
  nails: [
    { name: "Valeria", color: "#c7513b", days: [1, 5], ranges: [["10:00", "19:00"]] },
    { name: "Mónica", color: "#8a63d2", days: [2, 6], ranges: [["09:00", "17:00"]] },
  ],
};

function seedBusiness(state: State, seed: MockBusinessSeed, memberSeeds: MockMemberSeed[]): BizState {
  const locations: BizState["locations"] = seed.locations.map((l, position) => ({
    id: l.id,
    name: l.name,
    address: position === 0 ? "Centro comercial demo, local 4" : null,
    phone: null,
    timezone: seed.timezone,
    active: true,
    position,
    hours: [...weekdays(1, 5, "08:00", "18:00"), { weekday: 6, start: "08:00", end: "12:00" }],
    history: true,
  }));
  const categories: CategoryView[] = [];
  const services: ServiceView[] = [];
  for (const [position, c] of (CATALOG_SEEDS[seed.industry] ?? CATALOG_SEEDS.aesthetics).entries()) {
    const category = { id: nextId(state), name: c.name, position };
    categories.push(category);
    c.services.forEach(([name, durationMin, bufferMin, priceCents, variablePrice], i) =>
      services.push({
        id: nextId(state),
        categoryId: category.id,
        name,
        description: null,
        durationMin,
        bufferMin,
        priceCents,
        variablePrice: variablePrice ?? false,
        onlineBooking: true,
        active: true,
        position: i,
        locationIds: [],
      }),
    );
  }
  const members: Member[] = memberSeeds.map((m, i) => ({
    membershipId: `00000000-0000-4000-a000-${String(i + 1).padStart(4, "0")}${seed.id.slice(-8)}`,
    userId: m.userId,
    name: m.name,
    email: m.email,
    role: m.role,
    active: true,
    status: "active",
    allLocations: m.role === "owner" || !m.locationIds?.length,
    locationIds: m.role === "owner" ? [] : (m.locationIds ?? []),
    totpEnabled: m.totpEnabled,
    createdAt: "2026-09-02T15:00:00.000Z",
  }));
  const staff: BizState["staff"] = [];
  const staffHours: BizState["staffHours"] = [];
  (STAFF_SEEDS[seed.industry] ?? []).forEach((s, position) => {
    const id = nextId(state);
    const member = members.find((m) => m.email === s.email);
    staff.push({ id, name: s.name, color: s.color, active: true, position, membershipId: member?.membershipId ?? null, history: true });
    const locationId = locations[position % locations.length].id;
    for (let d = s.days[0]; d <= s.days[1]; d++) for (const [start, end] of s.ranges) staffHours.push({ staffId: id, locationId, weekday: d, start, end });
  });
  const offset = seed.timezone === "America/Costa_Rica" ? "-06:00" : "-05:00";
  return {
    settings: {
      id: seed.id,
      slug: seed.slug,
      name: seed.name,
      industry: seed.industry,
      plan: seed.plan,
      status: "active",
      timezone: seed.timezone,
      currency: seed.currency,
      country: seed.country,
      terminology: { ...seed.terminology },
      reminderChannels: ["whatsapp"],
      branding: { ...seed.branding },
      brandingEditable: true,
      legal: { legalName: null, taxId: null, billingEmail: null },
      version: 1,
    },
    locations,
    categories,
    services,
    staff,
    staffHours,
    staffServices: {},
    timeOff: [
      {
        id: nextId(state),
        scope: "business",
        locationId: null,
        staffId: null,
        startsAt: new Date(`2026-12-25T00:00:00${offset}`).toISOString(),
        endsAt: new Date(`2026-12-26T00:00:00${offset}`).toISOString(),
        reason: "Navidad",
      },
    ],
    members,
  };
}

// ── Vistas ──────────────────────────────────────────────────────────────────

function settingsView(b: BizState, manager: boolean): BusinessSettings {
  const { version, legal, terminology, ...rest } = b.settings;
  return {
    ...rest,
    terminology: { ...DEFAULT_TERMINOLOGY, ...terminology },
    legal: manager ? legal : null,
    updatedAt: new Date(Date.UTC(2026, 9, 1) + version * 1000).toISOString(),
  };
}

const byPosition = <T extends { position: number }>(list: T[]) => [...list].sort((a, b) => a.position - b.position);

function stripHistory<T extends WithHistory>(item: T): Omit<T, "history"> {
  const { history: _history, ...rest } = item;
  return rest;
}

function staffView(b: BizState, id: string): StaffView | null {
  const s = b.staff.find((x) => x.id === id);
  if (!s) return null;
  const member = b.members.find((m) => m.membershipId === s.membershipId);
  return {
    ...stripHistory(s),
    member: member ? { name: member.name, email: member.email } : null,
    hours: b.staffHours.filter((h) => h.staffId === id).map((h) => ({ ...h })),
  };
}

function catalogView(b: BizState) {
  const categories = byPosition(b.categories);
  const order = (s: ServiceView) => (s.categoryId ? categories.findIndex((c) => c.id === s.categoryId) : Number.MAX_SAFE_INTEGER);
  const services = [...b.services].sort((x, y) => order(x) - order(y) || x.position - y.position);
  return { categories, services };
}

// ── Respuestas y validación ─────────────────────────────────────────────────

const ok = (data: unknown, status = 200): TransportResponse => ({ status, payload: { ok: true, data } });
const noContent = (): TransportResponse => ({ status: 204, payload: undefined });
const fail = (status: number, code: string, error: string, fields?: Record<string, string>): TransportResponse => ({
  status,
  payload: { ok: false, error, code, ...(fields ? { fields } : {}) },
});
const invalid = (fields: Record<string, string>) => fail(400, "validation_error", "Datos inválidos: revisá los campos marcados.", fields);
const notFound = (what: string) => fail(404, "not_found", `${what} no existe.`);
const forbidden = () => fail(403, "forbidden_role", "No tenés permiso para esta acción.");

type Body = Record<string, unknown>;
const asBody = (body: unknown): Body => (typeof body === "object" && body !== null ? (body as Body) : {});
const text = (body: Body, key: string) => (typeof body[key] === "string" ? (body[key] as string).trim() : "");
const has = (body: Body, key: string) => Object.prototype.hasOwnProperty.call(body, key);

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const RE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Mismas reglas que el backend (src/modules/business/hours.ts), con los errores en `body.hours.i.campo`. */
function hoursErrors(hours: WeeklyBlock[]): Record<string, string> {
  const fields: Record<string, string> = {};
  hours.forEach((b, i) => {
    if (!RE_TIME.test(b.start)) fields[`body.hours.${i}.start`] = "Hora inválida (formato HH:MM).";
    else if (!(RE_TIME.test(b.end) || b.end === "24:00")) fields[`body.hours.${i}.end`] = "Hora inválida (formato HH:MM).";
    else if (minutes(b.end) <= minutes(b.start)) fields[`body.hours.${i}.end`] = "La hora de fin tiene que ser después de la de inicio.";
  });
  hours.forEach((b, i) => {
    if (fields[`body.hours.${i}.start`] || fields[`body.hours.${i}.end`]) return;
    const clash = hours.some((o, j) => j < i && o.weekday === b.weekday && minutes(b.start) < minutes(o.end) && minutes(o.start) < minutes(b.end));
    if (clash) fields[`body.hours.${i}.start`] = "Este tramo se cruza con otro del mismo día.";
  });
  return fields;
}

function parseOrder(body: Body, current: string[]): string[] | null {
  const ids = Array.isArray(body.ids) ? (body.ids as string[]) : [];
  const same = ids.length === current.length && new Set(ids).size === ids.length && current.every((id) => ids.includes(id));
  return same ? ids : null;
}

const badOrder = () => invalid({ "body.ids": "La lista tiene que traer todos los elementos actuales, una vez cada uno." });

// ── Rutas ───────────────────────────────────────────────────────────────────

function route(req: TransportRequest, state: State, session: MockSession, b: BizState): TransportResponse | null {
  const path = req.path.split("?")[0];
  const body = asBody(req.body);
  const manager = MANAGERS.includes(session.role);
  const write = req.method !== "GET";
  const key = `${req.method} ${path}`;
  const id = (re: RegExp) => re.exec(path)?.[1] ?? null;
  const touch = () => (b.settings.version += 1);

  if (path.startsWith("/team/")) {
    if (!manager) return forbidden();
    return teamRoute(req, state, session, b, body);
  }
  if (write && !manager) return forbidden();

  // ── Negocio ──
  if (key === "GET /settings/business") return ok(settingsView(b, manager));
  if (key === "PATCH /settings/business") {
    const fields: Record<string, string> = {};
    if (has(body, "name") && !text(body, "name")) fields["body.name"] = "No puede quedar vacío.";
    if (has(body, "currency") && !/^[A-Za-z]{3}$/.test(text(body, "currency"))) fields["body.currency"] = "Moneda inválida (código ISO de 3 letras, ej. CRC).";
    const logo = (body.branding as Body | undefined)?.logoUrl;
    if (typeof logo === "string" && !logo.startsWith("https://")) fields["body.branding.logoUrl"] = "El logo tiene que ser una URL https.";
    if (Object.keys(fields).length > 0) return invalid(fields);
    const s = b.settings;
    if (has(body, "name")) s.name = text(body, "name");
    for (const k of ["timezone", "country"] as const) if (has(body, k)) s[k] = text(body, k);
    if (has(body, "currency")) s.currency = text(body, "currency").toUpperCase();
    for (const k of ["legalName", "taxId", "billingEmail"] as const) if (has(body, k)) s.legal[k] = text(body, k) || null;
    if (body.terminology && typeof body.terminology === "object") {
      for (const [k, v] of Object.entries(body.terminology as Record<string, string>)) {
        const term = String(v ?? "").trim().toLocaleLowerCase("es");
        const dk = k as keyof Terminology;
        if (!term || term === DEFAULT_TERMINOLOGY[dk]) delete s.terminology[dk];
        else s.terminology[dk] = term;
      }
    }
    if (Array.isArray(body.reminderChannels)) s.reminderChannels = body.reminderChannels as ReminderChannel[];
    if (body.branding && typeof body.branding === "object") {
      for (const [k, v] of Object.entries(body.branding as Record<string, string | null>)) {
        const bk = k as keyof Branding;
        if (v === null || v === "") delete s.branding[bk];
        else s.branding[bk] = v;
      }
    }
    touch();
    return ok(settingsView(b, manager));
  }

  // ── Sucursales ──
  const visible = (l: LocationView) => !session.locationIds || session.locationIds.includes(l.id);
  if (key === "GET /settings/locations") return ok(byPosition(b.locations).filter(visible).map(stripHistory));
  if (key === "POST /settings/locations") {
    if (session.locationIds) return fail(403, "location_forbidden", "No tenés acceso a esta sucursal.");
    if (!text(body, "name")) return invalid({ "body.name": "No puede quedar vacío." });
    const location = {
      id: nextId(state),
      name: text(body, "name"),
      address: text(body, "address") || null,
      phone: text(body, "phone") || null,
      timezone: text(body, "timezone") || b.settings.timezone,
      active: true,
      position: b.locations.length,
      hours: [...weekdays(1, 5, "08:00", "18:00"), { weekday: 6, start: "08:00", end: "12:00" }],
    };
    b.locations.push(location);
    touch();
    return ok(location, 201);
  }
  const hoursLocationId = id(/^\/settings\/locations\/([^/]+)\/hours$/);
  if (req.method === "PUT" && hoursLocationId) {
    const location = b.locations.find((l) => l.id === hoursLocationId);
    if (!location) return notFound("Esa sucursal");
    const hours = (Array.isArray(body.hours) ? body.hours : []) as WeeklyBlock[];
    const fields = hoursErrors(hours);
    if (Object.keys(fields).length > 0) return invalid(fields);
    location.hours = [...hours].sort((x, y) => x.weekday - y.weekday || minutes(x.start) - minutes(y.start));
    touch();
    return ok(stripHistory(location));
  }
  const locationId = id(/^\/settings\/locations\/([^/]+)$/);
  if (locationId) {
    const location = b.locations.find((l) => l.id === locationId);
    if (!location) return notFound("Esa sucursal");
    const activeOthers = b.locations.filter((l) => l.active && l.id !== locationId).length;
    const last = () => fail(409, "last_location", "El negocio tiene que tener al menos una sucursal activa.");
    if (req.method === "PATCH") {
      if (has(body, "name") && !text(body, "name")) return invalid({ "body.name": "No puede quedar vacío." });
      if (body.active === false && location.active && activeOthers === 0) return last();
      if (has(body, "name")) location.name = text(body, "name");
      if (has(body, "address")) location.address = text(body, "address") || null;
      if (has(body, "phone")) location.phone = text(body, "phone") || null;
      if (has(body, "timezone")) location.timezone = text(body, "timezone");
      if (typeof body.active === "boolean") location.active = body.active;
      touch();
      return ok(stripHistory(location));
    }
    if (req.method === "DELETE") {
      if (location.active && activeOthers === 0) return last();
      touch();
      if (location.history || b.members.some((m) => m.locationIds.includes(locationId))) {
        location.active = false;
        return ok({ deleted: false, location: stripHistory(location) });
      }
      b.locations = b.locations.filter((l) => l.id !== locationId);
      b.staffHours = b.staffHours.filter((h) => h.locationId !== locationId);
      return ok({ deleted: true });
    }
  }

  // ── Catálogo ──
  if (key === "GET /settings/services") return ok(catalogView(b));
  if (key === "POST /settings/service-categories") {
    if (!text(body, "name")) return invalid({ "body.name": "No puede quedar vacío." });
    const category = { id: nextId(state), name: text(body, "name"), position: b.categories.length };
    b.categories.push(category);
    return ok(category, 201);
  }
  if (key === "PUT /settings/service-categories/order") {
    const ids = parseOrder(body, b.categories.map((c) => c.id));
    if (!ids) return badOrder();
    for (const c of b.categories) c.position = ids.indexOf(c.id);
    return ok(byPosition(b.categories));
  }
  const categoryId = id(/^\/settings\/service-categories\/([^/]+)$/);
  if (categoryId) {
    const category = b.categories.find((c) => c.id === categoryId);
    if (!category) return notFound("Esa categoría");
    if (req.method === "PATCH") {
      if (!text(body, "name")) return invalid({ "body.name": "No puede quedar vacío." });
      category.name = text(body, "name");
      return ok(category);
    }
    if (req.method === "DELETE") {
      let position = b.services.filter((s) => s.categoryId === null).length;
      for (const s of byPosition(b.services.filter((x) => x.categoryId === categoryId))) Object.assign(s, { categoryId: null, position: position++ });
      b.categories = b.categories.filter((c) => c.id !== categoryId);
      return noContent();
    }
  }
  const serviceFields = (input: Body, partial: boolean): Record<string, string> => {
    const fields: Record<string, string> = {};
    if ((!partial || has(input, "name")) && !text(input, "name")) fields["body.name"] = "No puede quedar vacío.";
    if ((!partial || has(input, "durationMin")) && !(Number.isInteger(input.durationMin) && (input.durationMin as number) >= 5 && (input.durationMin as number) % 5 === 0)) {
      fields["body.durationMin"] = "Debe ser múltiplo de 5.";
    }
    if (has(input, "priceCents") && !(Number.isInteger(input.priceCents) && (input.priceCents as number) >= 0)) fields["body.priceCents"] = "Se esperaba un número entero.";
    return fields;
  };
  if (key === "POST /settings/services") {
    const fields = serviceFields(body, false);
    if (Object.keys(fields).length > 0) return invalid(fields);
    const categoryIdIn = (body.categoryId as string | null) ?? null;
    const service: ServiceView = {
      id: nextId(state),
      categoryId: categoryIdIn,
      name: text(body, "name"),
      description: text(body, "description") || null,
      durationMin: body.durationMin as number,
      bufferMin: (body.bufferMin as number) ?? 0,
      priceCents: (body.priceCents as number) ?? 0,
      variablePrice: body.variablePrice === true,
      onlineBooking: body.onlineBooking !== false,
      active: body.active !== false,
      position: b.services.filter((s) => s.categoryId === categoryIdIn).length,
      locationIds: Array.isArray(body.locationIds) ? (body.locationIds as string[]) : [],
    };
    b.services.push(service);
    return ok(service, 201);
  }
  if (key === "PUT /settings/services/order") {
    const cat = (body.categoryId as string | null) ?? null;
    const ids = parseOrder(body, b.services.filter((s) => s.categoryId === cat).map((s) => s.id));
    if (!ids) return badOrder();
    for (const s of b.services) if (s.categoryId === cat) s.position = ids.indexOf(s.id);
    return ok(catalogView(b).services);
  }
  const serviceId = id(/^\/settings\/services\/([^/]+)$/);
  if (serviceId) {
    const service = b.services.find((s) => s.id === serviceId);
    if (!service) return notFound("Ese servicio");
    if (req.method === "PATCH") {
      const fields = serviceFields(body, true);
      if (Object.keys(fields).length > 0) return invalid(fields);
      if (has(body, "categoryId") && body.categoryId !== service.categoryId) {
        service.position = b.services.filter((s) => s.categoryId === body.categoryId).length;
      }
      Object.assign(service, body);
      if (has(body, "description")) service.description = text(body, "description") || null;
      if (has(body, "name")) service.name = text(body, "name");
      return ok(service);
    }
    if (req.method === "DELETE") {
      b.services = b.services.filter((s) => s.id !== serviceId);
      for (const list of Object.values(b.staffServices)) list.splice(0, list.length, ...list.filter((x) => x.serviceId !== serviceId));
      return noContent();
    }
  }

  // ── Equipo ──
  if (key === "GET /settings/staff") return ok(byPosition(b.staff).map((s) => staffView(b, s.id)));
  const membershipTaken = (membershipId: unknown, exceptId?: string) =>
    typeof membershipId === "string" && b.staff.some((s) => s.membershipId === membershipId && s.id !== exceptId);
  const takenError = () => fail(409, "membership_taken", "Ese usuario ya está vinculado a otro profesional.");
  if (key === "POST /settings/staff") {
    if (!text(body, "name")) return invalid({ "body.name": "No puede quedar vacío." });
    if (membershipTaken(body.membershipId)) return takenError();
    const staffId = nextId(state);
    b.staff.push({
      id: staffId,
      name: text(body, "name"),
      color: (body.color as string | null) ?? "#0b7d72",
      active: body.active !== false,
      position: b.staff.length,
      membershipId: (body.membershipId as string | null) ?? null,
    });
    return ok(staffView(b, staffId), 201);
  }
  if (key === "PUT /settings/staff/order") {
    const ids = parseOrder(body, b.staff.map((s) => s.id));
    if (!ids) return badOrder();
    for (const s of b.staff) s.position = ids.indexOf(s.id);
    return ok(byPosition(b.staff).map((s) => staffView(b, s.id)));
  }
  const staffHoursId = id(/^\/settings\/staff\/([^/]+)\/hours$/);
  if (req.method === "PUT" && staffHoursId) {
    if (!b.staff.some((s) => s.id === staffHoursId)) return notFound("Ese profesional");
    const loc = text(body, "locationId");
    if (session.locationIds && !session.locationIds.includes(loc)) return fail(403, "location_forbidden", "No tenés acceso a esta sucursal.");
    if (!b.locations.some((l) => l.id === loc)) return invalid({ "body.locationId": "Alguna de las sucursales no existe en este negocio." });
    const hours = (Array.isArray(body.hours) ? body.hours : []) as WeeklyBlock[];
    const fields = hoursErrors(hours);
    const elsewhere = b.staffHours.filter((h) => h.staffId === staffHoursId && h.locationId !== loc);
    hours.forEach((h, i) => {
      if (elsewhere.some((o) => o.weekday === h.weekday && minutes(h.start) < minutes(o.end) && minutes(o.start) < minutes(h.end))) {
        fields[`body.hours.${i}.start`] ??= "Se cruza con el horario de este profesional en otra sucursal.";
      }
    });
    if (Object.keys(fields).length > 0) return invalid(fields);
    b.staffHours = [...b.staffHours.filter((h) => !(h.staffId === staffHoursId && h.locationId === loc)), ...hours.map((h) => ({ ...h, staffId: staffHoursId, locationId: loc }))];
    return ok(staffView(b, staffHoursId));
  }
  const staffServicesId = id(/^\/settings\/staff\/([^/]+)\/services$/);
  if (staffServicesId) {
    if (!b.staff.some((s) => s.id === staffServicesId)) return notFound("Ese profesional");
    if (req.method === "PUT") {
      const items = (Array.isArray(body.services) ? body.services : []) as StaffServiceItem[];
      if (new Set(items.map((i) => i.serviceId)).size !== items.length) return invalid({ "body.services": "Cada servicio va una sola vez." });
      b.staffServices[staffServicesId] = items.map((i) => ({ serviceId: i.serviceId, priceCents: i.priceCents ?? null, durationMin: i.durationMin ?? null }));
    }
    const list = b.staffServices[staffServicesId] ?? [];
    return ok({ staffId: staffServicesId, allServices: list.length === 0, services: list });
  }
  const staffId = id(/^\/settings\/staff\/([^/]+)$/);
  if (staffId) {
    const s = b.staff.find((x) => x.id === staffId);
    if (!s) return notFound("Ese profesional");
    if (req.method === "PATCH") {
      if (has(body, "name") && !text(body, "name")) return invalid({ "body.name": "No puede quedar vacío." });
      if (membershipTaken(body.membershipId, staffId)) return takenError();
      for (const k of ["color", "active", "membershipId"] as const) if (has(body, k)) Object.assign(s, { [k]: body[k] });
      if (has(body, "name")) s.name = text(body, "name");
      return ok(staffView(b, staffId));
    }
    if (req.method === "DELETE") {
      if (s.history) {
        s.active = false;
        return ok({ deleted: false, staff: staffView(b, staffId) });
      }
      b.staff = b.staff.filter((x) => x.id !== staffId);
      b.staffHours = b.staffHours.filter((h) => h.staffId !== staffId);
      return ok({ deleted: true });
    }
  }

  // ── Ausencias ──
  if (key === "GET /settings/time-off") return ok([...b.timeOff].sort((x, y) => x.startsAt.localeCompare(y.startsAt)));
  const timeOffFields = (input: { startsAt: string; endsAt: string }) =>
    new Date(input.endsAt) <= new Date(input.startsAt) || Number.isNaN(Date.parse(input.startsAt)) ? { "body.endsAt": "El fin tiene que ser después del inicio." } : null;
  const scopeOf = (e: Pick<TimeOffEntry, "locationId" | "staffId">) => (e.staffId ? "staff" : e.locationId ? "location" : "business");
  if (key === "POST /settings/time-off") {
    const entry: TimeOffEntry = {
      id: nextId(state),
      scope: "business",
      locationId: (body.locationId as string | null) ?? null,
      staffId: (body.staffId as string | null) ?? null,
      startsAt: new Date(text(body, "startsAt")).toISOString(),
      endsAt: new Date(text(body, "endsAt")).toISOString(),
      reason: text(body, "reason") || null,
    };
    const fields = timeOffFields(entry);
    if (fields) return invalid(fields);
    if (!entry.locationId && session.locationIds) return fail(403, "location_forbidden", "No tenés acceso a esta sucursal.");
    entry.scope = scopeOf(entry);
    b.timeOff.push(entry);
    return ok(entry, 201);
  }
  const timeOffId = id(/^\/settings\/time-off\/([^/]+)$/);
  if (timeOffId) {
    const entry = b.timeOff.find((e) => e.id === timeOffId);
    if (!entry) return notFound("Esa ausencia");
    if (req.method === "PATCH") {
      const next = { ...entry };
      for (const k of ["locationId", "staffId"] as const) if (has(body, k)) next[k] = (body[k] as string | null) ?? null;
      for (const k of ["startsAt", "endsAt"] as const) if (has(body, k)) next[k] = new Date(text(body, k)).toISOString();
      if (has(body, "reason")) next.reason = text(body, "reason") || null;
      const fields = timeOffFields(next);
      if (fields) return invalid(fields);
      Object.assign(entry, next, { scope: scopeOf(next) });
      return ok(entry);
    }
    if (req.method === "DELETE") {
      b.timeOff = b.timeOff.filter((e) => e.id !== timeOffId);
      return noContent();
    }
  }
  return null;
}

function teamRoute(req: TransportRequest, state: State, session: MockSession, b: BizState, body: Body): TransportResponse | null {
  const path = req.path.split("?")[0];
  if (req.method === "GET" && path === "/team/members") return ok(b.members);
  if (req.method === "POST" && path === "/team/invitations") {
    const email = text(body, "email").toLowerCase();
    const role = body.role as Role;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return invalid({ "body.email": "Correo electrónico inválido." });
    if (role === "owner" && session.role !== "owner") return fail(403, "forbidden_role", "Solo un dueño puede invitar a otro dueño.");
    const locationIds = role === "owner" ? [] : ((body.locationIds as string[] | undefined) ?? []);
    const existing = b.members.find((m) => m.email === email);
    if (existing && existing.status !== "invited") return fail(409, "already_member", "Esa persona ya es parte del equipo.");
    const member: Member = existing
      ? { ...existing, role, locationIds, allLocations: locationIds.length === 0, active: true }
      : {
          membershipId: nextId(state),
          userId: nextId(state),
          name: text(body, "name") || email.split("@")[0],
          email,
          role,
          active: true,
          status: "invited",
          allLocations: locationIds.length === 0,
          locationIds,
          totpEnabled: false,
          createdAt: new Date().toISOString(),
        };
    b.members = existing ? b.members.map((m) => (m.membershipId === member.membershipId ? member : m)) : [...b.members, member];
    return ok(member, 201);
  }
  const membershipId = /^\/team\/members\/([^/]+)$/.exec(path)?.[1];
  if (req.method === "PATCH" && membershipId) {
    const member = b.members.find((m) => m.membershipId === membershipId);
    if (!member) return fail(404, "not_found", "Esa persona no es parte del equipo.");
    const nextRole = (body.role as Role | undefined) ?? member.role;
    const nextActive = typeof body.active === "boolean" ? body.active : member.active;
    if ((member.role === "owner" || nextRole === "owner") && session.role !== "owner") {
      return fail(403, "forbidden_role", "Solo un dueño puede cambiar a otro dueño o nombrar dueños.");
    }
    const otherOwners = b.members.filter((m) => m.role === "owner" && m.active && m.membershipId !== membershipId).length;
    if (member.role === "owner" && member.active && (nextRole !== "owner" || !nextActive) && otherOwners === 0) {
      return fail(409, "last_owner", "Debe quedar al menos un dueño activo en el negocio.");
    }
    const locationIds = nextRole === "owner" ? [] : ((body.locationIds as string[] | undefined) ?? member.locationIds);
    Object.assign(member, {
      role: nextRole,
      active: nextActive,
      locationIds,
      allLocations: locationIds.length === 0,
      status: !nextActive ? "inactive" : member.status === "inactive" ? "active" : member.status,
    });
    return ok(member);
  }
  return null;
}

// ── Entrada desde lib/mockApi.ts ────────────────────────────────────────────

/**
 * Responde una ruta de Configuración (o de /team/*) del mock; null si no es suya. Sin
 * sesión → 401.
 */
export function settingsMockRoute(
  req: TransportRequest,
  session: MockSession | null,
  business: MockBusinessSeed | null,
  members: MockMemberSeed[],
): TransportResponse | null {
  const path = req.path.split("?")[0];
  if (!path.startsWith("/settings/") && !path.startsWith("/team/")) return null;
  if (!session || !business) return fail(401, "unauthorized", "Tu sesión no es válida o venció. Iniciá sesión de nuevo.");
  const state = loadState();
  state.businesses[business.id] ??= seedBusiness(state, business, members);
  const res = route(req, state, session, state.businesses[business.id]) ?? fail(404, "not_found", "Ruta inexistente en el mock.");
  saveState(state);
  return res;
}

/** Lo que necesita la Agenda simulada: sucursales, equipo con horario, servicios, ausencias y miembros. */
export interface MockAgendaSetup {
  timezone: string;
  locations: LocationView[];
  staff: StaffView[];
  services: ServiceView[];
  staffServices: Record<string, StaffServiceItem[]>;
  timeOff: TimeOffEntry[];
  members: { membershipId: string; email: string }[];
}

/** Configuración del negocio para la Agenda simulada (la siembra si hace falta). */
export function mockAgendaSetup(business: MockBusinessSeed, members: MockMemberSeed[]): MockAgendaSetup {
  const state = loadState();
  if (!state.businesses[business.id]) {
    state.businesses[business.id] = seedBusiness(state, business, members);
    saveState(state);
  }
  const b = state.businesses[business.id];
  return {
    timezone: b.settings.timezone,
    locations: byPosition(b.locations).map(stripHistory),
    staff: byPosition(b.staff).flatMap((s) => {
      const view = staffView(b, s.id);
      return view ? [view] : [];
    }),
    services: catalogView(b).services,
    staffServices: b.staffServices,
    timeOff: b.timeOff,
    members: b.members.map((m) => ({ membershipId: m.membershipId, email: m.email })),
  };
}

/** Lo que cambió del negocio en el mock (para que `me` lo refleje), o null si no se tocó. */
export function settingsOverlay(businessId: string): {
  name: string;
  currency: string;
  timezone: string;
  terminology: Partial<Terminology>;
  branding: Branding;
  locations: LocationRef[];
} | null {
  const b = loadState().businesses[businessId];
  if (!b) return null;
  return {
    name: b.settings.name,
    currency: b.settings.currency,
    timezone: b.settings.timezone,
    terminology: { ...b.settings.terminology },
    branding: { ...b.settings.branding },
    locations: byPosition(b.locations)
      .filter((l) => l.active)
      .map((l) => ({ id: l.id, name: l.name })),
  };
}
