import { sql } from "drizzle-orm";
import type { Tx } from "../db/scope";
import { HttpError } from "../http/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Contrato entre el núcleo y los planes (PLAN-GESTION.md §5). Los planes viven en
// `modules/billing`, que el núcleo NO puede importar (test/architecture/
// moduleBoundaries.test.ts): el núcleo declara acá lo que necesita saber del plan y la
// composición (src/app.ts) le inyecta la implementación de billing. Mismo criterio que
// `ModuleGate` en src/platform/http/routeTypes.ts.
//
//   • `quota`: cupo de un recurso (sucursales, profesionales, usuarios activos). El núcleo
//     lo resuelve ANTES de abrir la transacción (lee el caché con el pool) y lo hace
//     cumplir ADENTRO con `assertQuota` (lock por negocio y recurso + conteo).
//   • `hasFeature`: lo del plan que no es una ruta entera (p. ej. la marca propia).
//   • `snapshot`: plan, módulos, nivel de clientes, límites y uso para `me` y el panel.
// ─────────────────────────────────────────────────────────────────────────────

/** Recursos con cupo por plan. */
export const PLAN_RESOURCES = ["locations", "staff", "users"] as const;
export type PlanResource = (typeof PLAN_RESOURCES)[number];

/** Funciones del plan que no son un módulo con rutas propias. */
export const PLAN_FEATURES = ["branding"] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

/** Nivel de la ficha de clientes: `basic` (ficha automática) o `full` (CRM del Pro). */
export type ClientsTier = "basic" | "full";

/** Cupo de un recurso: máximo de activos, o null = sin tope. */
export type PlanQuota = (businessId: string, resource: PlanResource) => Promise<number | null>;

/** Límites del plan tal como los ve el panel (null = sin tope). */
export interface PlanLimitsView {
  locations: number | null;
  staff: number | null;
  users: number | null;
  /** Conversaciones del agente por mes. */
  aiConversations: number | null;
}

/** Uso actual frente a esos límites. */
export interface PlanUsageView {
  /** Mes del uso del agente (`YYYY-MM`, hora de Costa Rica). */
  month: string;
  locations: number;
  staff: number;
  users: number;
  /** Conversaciones del agente en el mes; null = todavía no se mide (sin módulo WhatsApp). */
  aiConversations: number | null;
}

/** Lo que el panel necesita del plan (`me.plan`). */
export interface PlanSnapshot {
  /** Plan contratado (`basic` | `pro`). */
  id: string;
  /** Nombre para mostrar: "Básico", "Pro" o "Pro sin agente". */
  label: string;
  clientsTier: ClientsTier;
  /** Módulos habilitados (plan + extras − apagados). Igual que `me.modules`. */
  modules: string[];
  features: PlanFeature[];
  /** Estado del cobro manual (`trial` | `active` | `past_due` | `cancelled`). */
  billingStatus: string;
  limits: PlanLimitsView;
  usage: PlanUsageView;
}

/** Lo inyectable del plan que usan las rutas del núcleo. */
export interface PlanHooks {
  /** Módulos habilitados del negocio (`me.modules`). */
  enabledModules(businessId: string): Promise<readonly string[]>;
  quota: PlanQuota;
  hasFeature(businessId: string, feature: PlanFeature): Promise<boolean>;
  snapshot(businessId: string): Promise<PlanSnapshot>;
}

// ── Cupos dentro de la transacción ──────────────────────────────────────────

const RESOURCE_NOUNS: Record<PlanResource, [singular: string, plural: string]> = {
  locations: ["sucursal activa", "sucursales activas"],
  staff: ["profesional activo", "profesionales activos"],
  users: ["usuario", "usuarios"],
};

/** 403 `plan_limit_reached` con un mensaje que dice el tope y qué hacer. */
export function planLimitReached(resource: PlanResource, limit: number): HttpError {
  const [one, many] = RESOURCE_NOUNS[resource];
  const what = limit === 1 ? `1 ${one}` : `${limit} ${many}`;
  return new HttpError(
    403,
    `Tu plan incluye hasta ${what} y ya llegaste a ese tope. Para sumar más, ampliá tu plan en Configuración › Plan.`,
    "plan_limit_reached",
  );
}

/**
 * Hace cumplir el cupo de `resource` DENTRO de la transacción que va a sumar `adding`
 * activos (alta, reactivación, invitación). Toma un advisory lock de TRANSACCIÓN por
 * (negocio, recurso) para que dos altas simultáneas no pasen las dos con el último lugar,
 * y después cuenta con `count` (que ve lo confirmado por la otra). `limit` null = sin tope.
 */
export async function assertQuota(
  tx: Tx,
  input: { businessId: string; resource: PlanResource; limit: number | null | undefined; count: () => Promise<number>; adding?: number },
): Promise<void> {
  const { businessId, resource, limit } = input;
  const adding = input.adding ?? 1;
  if (limit === null || limit === undefined || adding <= 0) return;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`plan_quota:${businessId}:${resource}`}, 0))`);
  const current = await input.count();
  if (current + adding > limit) throw planLimitReached(resource, limit);
}
