import type { IconId } from "../ui/Icons";
import { DEFAULT_TERMINOLOGY, type Me, type Role, type Terminology } from "../lib/contract";

// ─────────────────────────────────────────────────────────────────────────────
// Menú del panel (PLAN-GESTION.md §6) y reglas de acceso por rol y plan, en UN lugar: el
// menú lateral, la barra inferior, el botón "+ Nuevo" y las guardas de ruta leen de acá.
//
// Acceso de una sección para la sesión actual:
//   • "hidden": el rol no la usa, o el plan no trae el módulo y no es un upsell
//     (p. ej. un Pro sin agente no ve WhatsApp IA).
//   • "locked": el negocio está en Básico y la sección es del Pro → se ve con candado y
//     abre el aviso "Disponible en el plan Pro" (el upsell vive en el menú).
//   • "open".
//
// Los nombres de módulo (`sales`, `reports`, …) son los del backend (`me.modules`).
// ─────────────────────────────────────────────────────────────────────────────

export type SectionId = "home" | "agenda" | "clients" | "sales" | "reports" | "whatsapp" | "campaigns" | "settings";
export type NavGroup = "main" | "modules" | "settings";
export type Access = "open" | "locked" | "hidden";

interface Gate {
  roles: readonly Role[];
  /** Módulo del plan que hace falta, según el rol. Sin módulo = núcleo, siempre incluido. */
  module?: (role: Role) => string | undefined;
  /** Solo en el plan Pro, aunque no tenga un módulo propio. */
  proOnly?: boolean;
  /** Solo con el CRM completo de clientes (`me.plan.clientsTier = full`, plan Pro). */
  crm?: boolean;
  /** Si el plan Básico no trae el módulo: candado (true) u oculto (false). */
  upsell?: boolean;
}

export interface SectionDef extends Gate {
  id: SectionId;
  path: string;
  icon: IconId;
  group: NavGroup;
  label: (t: Terminology, role: Role) => string;
  /** Qué va a tener la sección (se muestra en el estado vacío de esta etapa). */
  planned: (t: Terminology, role: Role) => string[];
  description: (t: Terminology, role: Role) => string;
}

const ALL_ROLES: readonly Role[] = ["owner", "admin", "front_desk", "staff"];
const MANAGERS: readonly Role[] = ["owner", "admin"];

export function capitalize(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase("es") + text.slice(1) : text;
}

/** Terminología del negocio completa: lo que trae el negocio sobre los defaults. */
export function terminologyOf(me: Me): Terminology {
  const custom = me.business.terminology ?? {};
  const merged = { ...DEFAULT_TERMINOLOGY };
  for (const key of Object.keys(merged) as (keyof Terminology)[]) {
    const value = custom[key];
    if (typeof value === "string" && value.trim()) merged[key] = value.trim();
  }
  return merged;
}

export const SECTIONS: readonly SectionDef[] = [
  {
    id: "home",
    path: "/",
    icon: "home",
    group: "main",
    roles: ["owner", "admin", "front_desk"],
    label: () => "Inicio",
    planned: (t) => [`${capitalize(t.appointments)} de hoy y próximas`, "Sin confirmar", "Conversaciones esperando", "Indicadores del día"],
    description: () => "Un resumen de tu día: lo que viene, lo pendiente y lo que necesita tu atención.",
  },
  {
    id: "agenda",
    path: "/agenda",
    icon: "calendar",
    group: "main",
    roles: ALL_ROLES,
    label: (_t, role) => (role === "staff" ? "Mi agenda" : "Agenda"),
    planned: (t, role) => (role === "staff" ? ["Día", "Semana"] : ["Día", "Semana", `Por ${t.staffMember}`]),
    description: (t, role) =>
      role === "staff"
        ? `Tus ${t.appointments} del día y de la semana.`
        : `Las ${t.appointments} por día, por semana y por ${t.staffMember}: crear, mover y cancelar.`,
  },
  {
    id: "clients",
    path: "/clients",
    icon: "users",
    group: "main",
    roles: ALL_ROLES,
    label: (t, role) => (role === "staff" ? `Mis ${t.clients}` : capitalize(t.clients)),
    planned: (t) => ["Lista", "Ficha", `Historial de ${t.appointments}`, "Notas"],
    description: (t) => `La ficha de cada ${t.client}, con su historial de ${t.appointments} y sus notas.`,
  },
  {
    id: "sales",
    path: "/sales",
    icon: "receipt",
    group: "main",
    roles: ALL_ROLES,
    module: (role) => (role === "staff" ? "commissions" : "sales"),
    upsell: true,
    label: (_t, role) => (role === "staff" ? "Mis comisiones" : "Ventas"),
    planned: (_t, role) => {
      if (role === "staff") return ["Comisiones del período", "Liquidaciones"];
      if (role === "front_desk") return ["Cobros", "Pendientes", "Resumen del día"];
      return ["Cobros", "Pendientes", "Resumen del día", "Comisiones"];
    },
    description: (_t, role) =>
      role === "staff"
        ? "Lo que llevás en comisiones sobre lo cobrado, y tus liquidaciones."
        : "Pagos y señas, lo pendiente de cobro y el resumen del día por método de pago.",
  },
  {
    id: "reports",
    path: "/reports",
    icon: "chart",
    group: "main",
    roles: MANAGERS,
    module: () => "reports",
    upsell: true,
    label: () => "Reportes",
    planned: (t) => ["Ventas", "Servicios", capitalize(t.staff), capitalize(t.clients), "Canales"],
    description: (t) => `Los números del negocio por período, por ${t.location} y por ${t.staffMember}, con exportación a CSV.`,
  },
  {
    id: "whatsapp",
    path: "/whatsapp",
    icon: "chat",
    group: "modules",
    roles: ["owner", "admin", "front_desk"],
    module: () => "whatsapp",
    upsell: false,
    label: () => "WhatsApp IA",
    planned: () => ["Bandeja", "Métricas", "Configuración del agente"],
    description: () => "Las conversaciones que atiende el agente, con la opción de tomar el control y responder vos.",
  },
  {
    id: "campaigns",
    path: "/campaigns",
    icon: "megaphone",
    group: "modules",
    roles: MANAGERS,
    module: () => "campaigns",
    upsell: true,
    label: () => "Campañas",
    planned: () => ["Campañas", "Segmentos"],
    description: (t) => `Mensajes a grupos de ${t.clients} para recordarles que vuelvan.`,
  },
  {
    id: "settings",
    path: "/settings",
    icon: "gear",
    group: "settings",
    // Recepción la ve en modo lectura (servicios, precios, horarios); edita dueño/admin.
    roles: ["owner", "admin", "front_desk"],
    label: () => "Configuración",
    planned: () => [],
    description: () => "Todo lo que define cómo trabaja tu negocio en el panel.",
  },
];

export function getSection(id: SectionId): SectionDef {
  const section = SECTIONS.find((s) => s.id === id);
  if (!section) throw new Error(`Sección desconocida: ${id}`);
  return section;
}

export function accessFor(me: Me, gate: Gate): Access {
  if (!gate.roles.includes(me.role)) return "hidden";
  const required = gate.module?.(me.role);
  const inPlan =
    (!required || me.modules.includes(required)) && (!gate.proOnly || me.business.plan === "pro") && (!gate.crm || me.plan.clientsTier === "full");
  if (inPlan) return "open";
  return gate.upsell && me.business.plan !== "pro" ? "locked" : "hidden";
}

export interface NavItem {
  section: SectionDef;
  label: string;
  access: Exclude<Access, "hidden">;
}

/** Ítems visibles del menú para la sesión, en el orden del menú. */
export function navItemsFor(me: Me): NavItem[] {
  const t = terminologyOf(me);
  return SECTIONS.flatMap((section) => {
    const access = accessFor(me, section);
    return access === "hidden" ? [] : [{ section, label: section.label(t, me.role), access }];
  });
}

/** Adónde va "/" para esta sesión: Inicio, o la primera sección abierta (un profesional no tiene Inicio). */
export function homePathFor(me: Me): string {
  const first = navItemsFor(me).find((item) => item.access === "open");
  return first?.section.path ?? "/agenda";
}

// ── Configuración (/settings/*) ─────────────────────────────────────────────

export interface SettingsPageDef extends Gate {
  slug: string;
  label: (t: Terminology) => string;
  description: (t: Terminology) => string;
  /** Del plan Pro y todavía sin pantalla (llega en I3/I4): candado también en el Pro. */
  comingSoon?: boolean;
}

/** Leen la configuración del negocio (recepción solo lee; profesionales no la ven en el menú). */
const SETTINGS_READERS: readonly Role[] = ["owner", "admin", "front_desk"];

export const SETTINGS_PAGES: readonly SettingsPageDef[] = [
  {
    slug: "business",
    roles: SETTINGS_READERS,
    label: () => "Negocio",
    description: () => "Nombre, rubro, moneda, zona horaria y la marca de tu negocio.",
  },
  {
    slug: "locations",
    roles: SETTINGS_READERS,
    label: (t) => capitalize(t.locations),
    description: (t) => `Tus ${t.locations} con su dirección, teléfono y horario.`,
  },
  {
    slug: "services",
    roles: SETTINGS_READERS,
    label: () => "Servicios",
    description: () => "Categorías y servicios con su duración, precio y tiempo de preparación.",
  },
  {
    slug: "team",
    roles: SETTINGS_READERS,
    label: () => "Equipo",
    description: (t) => `${capitalize(t.staff)}, sus horarios, los servicios que hacen y sus ausencias.`,
  },
  {
    slug: "custom-fields",
    roles: MANAGERS,
    crm: true,
    upsell: true,
    label: () => "Campos personalizados",
    description: (t) => `Datos extra para la ficha de cada ${t.client} y para cada ${t.appointment}.`,
  },
  {
    slug: "client-rules",
    roles: MANAGERS,
    crm: true,
    upsell: true,
    label: (t) => `Reglas de ${t.clients}`,
    description: (t) =>
      `Cuándo un ${t.client} es nuevo, VIP, está en riesgo o inactivo. Los estados se calculan solos con sus visitas y su gasto.`,
  },
  {
    slug: "payment-methods",
    roles: MANAGERS,
    module: () => "sales",
    upsell: true,
    comingSoon: true,
    label: () => "Métodos de pago",
    description: () => "Efectivo, SINPE, tarjeta, transferencia: los que aceptás en tu negocio.",
  },
  {
    slug: "users",
    roles: MANAGERS,
    label: () => "Usuarios y permisos",
    description: (t) => `Quién entra al panel, con qué rol y a qué ${t.locations}.`,
  },
  {
    slug: "plan",
    roles: ["owner"],
    label: () => "Plan",
    description: () => "Tu plan, los módulos incluidos y sus límites.",
  },
];

export function roleLabel(role: Role, t: Terminology): string {
  switch (role) {
    case "owner":
      return "Dueño";
    case "admin":
      return "Administración";
    case "front_desk":
      return "Recepción";
    case "staff":
      return capitalize(t.staffMember);
  }
}
