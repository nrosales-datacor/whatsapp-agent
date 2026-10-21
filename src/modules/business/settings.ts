// ─────────────────────────────────────────────────────────────────────────────
// Forma de la configuración del negocio que vive como JSONB en `businesses`
// (PLAN-GESTION.md §3 y §4) y sus valores por defecto. En la base se guarda solo lo que el
// negocio cambió (objeto parcial); quien lee (ver ./context.ts) completa con estos
// defaults. Así un default nuevo llega a todos los negocios sin migrar filas.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Terminología del negocio para la UI y el agente (§3): "cliente" o "paciente",
 * "profesional", "especialista" o "estilista", "cita" o "turno"… La precarga la plantilla
 * de rubro.
 */
export interface Terminology {
  client: string;
  clients: string;
  staffMember: string;
  staff: string;
  appointment: string;
  appointments: string;
  location: string;
  locations: string;
}

export const DEFAULT_TERMINOLOGY: Terminology = {
  client: "cliente",
  clients: "clientes",
  staffMember: "profesional",
  staff: "profesionales",
  appointment: "cita",
  appointments: "citas",
  location: "sucursal",
  locations: "sucursales",
};

/**
 * Umbrales del estado del cliente (§4: `new` / `active` / `vip` / `at_risk` /
 * `inactive`). El estado NO se guarda: se calcula al consultar desde la caché de `clients`
 * (visitas, última visita, gasto) y estas reglas.
 */
export interface ClientStatusRules {
  /** Sigue siendo "nuevo" mientras tenga a lo sumo estas visitas completadas. */
  newMaxVisits: number;
  /** VIP desde estas visitas (null = no se usa este criterio). */
  vipMinVisits: number | null;
  /** VIP desde este gasto total en céntimos (null = no se usa este criterio). */
  vipMinSpentCents: number | null;
  /** "En riesgo" si la última visita fue hace más de estos días. */
  atRiskAfterDays: number;
  /** "Inactivo" si la última visita fue hace más de estos días. */
  inactiveAfterDays: number;
}

export const DEFAULT_CLIENT_STATUS_RULES: ClientStatusRules = {
  newMaxVisits: 1,
  vipMinVisits: 10,
  vipMinSpentCents: null,
  atRiskAfterDays: 60,
  inactiveAfterDays: 120,
};

/** Canales por los que el negocio manda recordatorios (§4, "Canal del recordatorio"). */
export const REMINDER_CHANNELS = ["whatsapp", "email"] as const;
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number];

/**
 * Canales activos del negocio, en orden de preferencia: el primero es el default cuando
 * el cliente no eligió uno (o eligió uno que el negocio no tiene activo).
 */
export const DEFAULT_REMINDER_CHANNELS: readonly ReminderChannel[] = ["whatsapp"];

/** Marca propia (white-label): colores en hex `#rrggbb` y logo por URL. */
export interface Branding {
  accentColor?: string;
  headerColor?: string;
  logoUrl?: string;
}

/**
 * Lo contratado encima del plan (§5), en `businesses.extra_modules`:
 *   • `modules`: `true` suma un módulo que el plan no trae (p. ej. Básico + campañas),
 *     `false` apaga uno que sí trae (p. ej. el agente en un Pro: "Pro sin agente").
 *   • `limits`: cupos contratados que reemplazan los del plan (sucursales, profesionales,
 *     usuarios, topes del agente); null = sin tope.
 * La forma la valida `modules/billing` con Zod (dueño del catálogo de planes); acá solo el
 * tipo de la columna. Vacío = el plan tal cual.
 */
export interface ExtraModules {
  modules?: Partial<Record<string, boolean>>;
  limits?: Partial<Record<string, number | null>>;
}
