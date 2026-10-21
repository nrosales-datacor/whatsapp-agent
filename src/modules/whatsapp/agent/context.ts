import type { Executor } from "../../../platform/db/scope";
import { formatAmount } from "../../../platform/money/currency";
import { getBusinessContext, isIndustry, listLocations, loadIndustryTemplate, type Terminology, type WeeklyBlock } from "../../business";
import { getServices, listBookableStaff } from "../../catalog";
import { getAiSettings, type AiSettingsView } from "../settings";

// ─────────────────────────────────────────────────────────────────────────────
// Lo que el agente sabe del negocio en un turno: identidad, terminología, sucursales
// activas con su horario, servicios que se pueden agendar en línea, equipo y la
// configuración del agente (ai_settings). Todo por la API pública de cada módulo del
// núcleo (nunca sus tablas). Es la base del prompt (estable entre turnos: cacheable) y de
// las tools.
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentLocation {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  hours: readonly WeeklyBlock[];
}

export interface AgentService {
  id: string;
  name: string;
  description: string | null;
  durationMin: number;
  priceCents: number;
  variablePrice: boolean;
  /** Sucursales donde se ofrece; vacío = en todas. */
  locationIds: readonly string[];
}

export interface AgentStaff {
  id: string;
  name: string;
  /** Sucursales donde tiene horario. */
  locationIds: string[];
}

export interface AgentContext {
  businessId: string;
  businessName: string;
  /** "un negocio de estética", "un negocio de odontología"… */
  businessKind: string;
  country: string;
  currency: string;
  /** Zona del negocio (la fecha "de hoy" del prompt). */
  timezone: string;
  terminology: Terminology;
  /** Solo las activas, en el orden del negocio. */
  locations: AgentLocation[];
  /** Activos y agendables en línea, en el orden del catálogo. */
  services: AgentService[];
  /** Activos con horario en alguna sucursal activa. */
  staff: AgentStaff[];
  settings: AiSettingsView;
}

function businessKindOf(industry: string): string {
  if (!isIndustry(industry) || industry === "generic") return "un negocio de servicios con cita";
  return `un negocio de ${loadIndustryTemplate(industry).label.toLocaleLowerCase("es")}`;
}

/** Arma el contexto del agente. null si el negocio no existe. */
export async function loadAgentContext(executor: Executor, businessId: string): Promise<AgentContext | null> {
  const business = await getBusinessContext(executor, businessId);
  if (!business) return null;
  const settings = await getAiSettings(executor, businessId);
  const locations = (await listLocations(executor, businessId, { activeOnly: true })).map((l) => ({
    id: l.id,
    name: l.name,
    address: l.address,
    phone: l.phone,
    timezone: l.timezone,
    hours: l.hours,
  }));
  const activeIds = new Set(locations.map((l) => l.id));
  const services = (await getServices(executor, businessId, { activeOnly: true, onlineOnly: true }))
    .filter((s) => s.locationIds.length === 0 || s.locationIds.some((id) => activeIds.has(id)))
    .map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      durationMin: s.durationMin,
      priceCents: s.priceCents,
      variablePrice: s.variablePrice,
      locationIds: s.locationIds,
    }));
  // En serie: el executor puede ser una transacción (una sola conexión).
  const staffById = new Map<string, AgentStaff>();
  for (const location of locations) {
    for (const s of await listBookableStaff(executor, businessId, { locationId: location.id })) {
      const entry = staffById.get(s.id) ?? { id: s.id, name: s.name, locationIds: [] };
      entry.locationIds.push(location.id);
      staffById.set(s.id, entry);
    }
  }
  return {
    businessId,
    businessName: business.business.name,
    businessKind: businessKindOf(business.business.industry),
    country: business.business.country,
    currency: business.business.currency,
    timezone: business.business.timezone,
    terminology: business.terminology,
    locations,
    services,
    staff: [...staffById.values()],
    settings,
  };
}

/** Precio para mostrar: el de lista, "desde X (se cotiza)" si es variable, o "se cotiza" sin precio. */
export function priceText(cents: number, variablePrice: boolean, currency: string): string {
  if (!(cents > 0)) return "se cotiza";
  const amount = formatAmount(cents / 100, currency);
  return variablePrice ? `desde ${amount} (se cotiza)` : amount;
}
