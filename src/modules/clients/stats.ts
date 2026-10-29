import { and, asc, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import { withTenant, type Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import { getBusinessContext } from "../business";
import { clients } from "./schema";
import { notAnonymized } from "./service";
import { clientStatusSql } from "./status";

// ─────────────────────────────────────────────────────────────────────────────
// Lo que clients aporta a Reportes e Inicio completo (I5), en SQL sobre su propia tabla:
//
//   • Altas: clientes REGISTRADOS en un rango (nuevos en la base, vengan o no a una cita).
//   • En riesgo: el estado `at_risk` del CRM (./status.ts), calculado en la consulta con las
//     reglas del negocio (`businesses.client_status_rules`, modo fijo o por frecuencia). Es
//     la MISMA expresión SQL (`clientStatusSql`) que filtra la lista y cuenta los chips
//     (./search.ts), así Inicio, la lista de clientes y sus filtros dicen lo mismo.
// ─────────────────────────────────────────────────────────────────────────────

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
  /** null = todavía no vino: está en riesgo por el tiempo desde el alta. */
  lastVisitAt: string | null;
  visitCount: number;
}

export interface AtRiskClients {
  /** Cuántos están en riesgo (completo, no solo los listados): el número del chip «En riesgo». */
  count: number;
  /** Los primeros `limit`: los que llevan más tiempo sin venir (los más cerca de pasar a inactivos). */
  items: AtRiskClient[];
}

/**
 * Clientes con estado `at_risk` al instante `now` (ver el encabezado), sin anonimizados.
 * Del negocio entero: el cliente no es de una sucursal.
 */
export async function listClientsAtRisk(executor: Executor, businessId: string, input: { now?: Date; limit?: number } = {}): Promise<AtRiskClients> {
  const ctx = await getBusinessContext(executor, businessId);
  if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  const now = input.now ?? new Date();
  const where = and(eq(clients.businessId, businessId), notAnonymized, sql`${clientStatusSql(ctx.clientStatusRules, now)} = 'at_risk'`);
  // La referencia del estado: la última visita, o el alta si todavía no vino.
  const reference = sql`COALESCE(${clients.lastVisitAt}, ${clients.createdAt})`;
  return withTenant(executor, businessId, async (tx) => {
    const [total] = await tx.select({ n: count() }).from(clients).where(where);
    const rows = await tx
      .select({ id: clients.id, name: clients.name, lastVisitAt: clients.lastVisitAt, visitCount: clients.visitCount })
      .from(clients)
      .where(where)
      // Los que están por pasar a inactivos primero (la última oportunidad de recuperarlos).
      .orderBy(asc(reference), desc(clients.visitCount), asc(clients.id))
      .limit(Math.min(Math.max(input.limit ?? 5, 0), 50));
    return {
      count: Number(total?.n ?? 0),
      items: rows.map((r) => ({ id: r.id, name: r.name, lastVisitAt: r.lastVisitAt ? r.lastVisitAt.toISOString() : null, visitCount: r.visitCount })),
    };
  });
}
