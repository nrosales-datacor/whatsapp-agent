import { and, asc, count, eq, gt, gte, isNotNull, lt, lte, sql } from "drizzle-orm";
import { withTenant, type Executor } from "../../platform/db/scope";
import { clients } from "./schema";
import { notAnonymized } from "./service";

// ─────────────────────────────────────────────────────────────────────────────
// Lo que clients aporta a Reportes e Inicio completo (I5), en SQL sobre su propia tabla
// y la caché de visitas (`visit_count`, `last_visit_at`, que mantiene la agenda):
//
//   • Altas: clientes REGISTRADOS en un rango (nuevos en la base, vengan o no a una cita).
//   • En riesgo (provisorio): la última visita fue hace más de `atRiskAfterDays` pero
//     todavía no pasa de `inactiveAfterDays` (las reglas del negocio).
//
// TODO(I3): cuando el CRM sume los estados de cliente (`new|active|vip|at_risk|inactive`)
// calculados con `businesses.client_status_rules`, "en riesgo" tiene que salir de ESE
// cálculo (y este provisorio desaparece), para que Inicio, la lista y los filtros digan lo
// mismo.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** Clientes registrados (alta) en [from, to). Los anonimizados también cuentan (fueron altas). */
export async function countRegisteredClients(executor: Executor, businessId: string, range: { from: Date; to: Date }): Promise<number> {
  const [row] = await withTenant(executor, businessId, (tx) =>
    tx
      .select({ n: count() })
      .from(clients)
      .where(and(eq(clients.businessId, businessId), gte(clients.createdAt, range.from), lt(clients.createdAt, range.to))),
  );
  return Number(row?.n ?? 0);
}

export interface AtRiskClient {
  id: string;
  name: string;
  lastVisitAt: string;
  visitCount: number;
}

export interface AtRiskClients {
  /** Cuántos están en riesgo (completo, no solo los listados). */
  count: number;
  /** Los primeros `limit`: los que llevan más tiempo sin venir (los más cerca de pasar a inactivos). */
  items: AtRiskClient[];
  /** Cálculo provisorio por última visita hasta que el CRM traiga los estados (I3). */
  provisional: true;
}

/**
 * Clientes en riesgo (provisorio, ver el encabezado): última visita en
 * (now − inactiveAfterDays, now − atRiskAfterDays]. Sin anonimizados.
 */
export async function listClientsAtRisk(
  executor: Executor,
  businessId: string,
  input: { now?: Date; atRiskAfterDays: number; inactiveAfterDays: number; limit?: number },
): Promise<AtRiskClients> {
  const now = input.now ?? new Date();
  const riskFrom = new Date(now.getTime() - Math.max(input.atRiskAfterDays, 0) * DAY_MS);
  const inactiveFrom = new Date(now.getTime() - Math.max(input.inactiveAfterDays, input.atRiskAfterDays) * DAY_MS);
  const where = and(
    eq(clients.businessId, businessId),
    isNotNull(clients.lastVisitAt),
    lte(clients.lastVisitAt, riskFrom),
    gt(clients.lastVisitAt, inactiveFrom),
    notAnonymized,
  );
  return withTenant(executor, businessId, async (tx) => {
    const [total] = await tx.select({ n: count() }).from(clients).where(where);
    const rows = await tx
      .select({ id: clients.id, name: clients.name, lastVisitAt: clients.lastVisitAt, visitCount: clients.visitCount })
      .from(clients)
      .where(where)
      // Los que están por pasar a inactivos primero (la última oportunidad de recuperarlos).
      .orderBy(asc(clients.lastVisitAt), sql`${clients.visitCount} DESC`)
      .limit(Math.min(Math.max(input.limit ?? 5, 0), 50));
    return {
      count: Number(total?.n ?? 0),
      items: rows.map((r) => ({ id: r.id, name: r.name, lastVisitAt: (r.lastVisitAt as Date).toISOString(), visitCount: r.visitCount })),
      provisional: true as const,
    };
  });
}
