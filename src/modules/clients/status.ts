import { sql, type SQL } from "drizzle-orm";
import type { ClientStatusRules } from "../business";
import { clients } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Estado del cliente (PLAN-GESTION.md §4): `new` / `active` / `vip` / `at_risk` /
// `inactive`. NO se guarda: se calcula al consultar, desde la caché de `clients` (visitas,
// primera y última visita, gasto, VIP manual, alta) y las reglas del negocio
// (`businesses.client_status_rules`, completas con los defaults en el contexto).
//
// La misma regla en dos formas que tienen que dar SIEMPRE lo mismo (lo verifica
// test/unit/clientStatus.test.ts sobre una grilla de casos contra PGlite):
//   • `computeClientStatus`: TypeScript, para la ficha.
//   • `clientStatusSql`: una expresión SQL, para filtrar, contar y paginar la lista en la
//     base (los chips de estado y los segmentos de Campañas).
//
// Orden (gana la primera que se cumple). "Referencia" = la última visita, o el alta si
// todavía no vino ninguna vez:
//   1. inactive: pasaron MÁS de `inactiveAfterDays` desde la referencia.
//   2. at_risk:  pasaron MÁS días que el umbral de riesgo desde la referencia:
//                • modo fijo: `atRiskAfterDays`;
//                • modo frecuencia, con 2+ visitas: `atRiskFrequencyFactor` × su intervalo
//                  promedio entre visitas ((última − primera) / (visitas − 1)), nunca menos
//                  de MIN_AT_RISK_DAYS; con menos de 2 visitas, `atRiskAfterDays`.
//   3. vip:      VIP manual, o por reglas (visitas ≥ `vipMinVisits` o gasto ≥
//                `vipMinSpentCents`).
//   4. new:      su primera visita (o el alta, si no vino) fue hace a lo sumo `newDays`.
//   5. active:   el resto.
//
// Un VIP que deja de venir pasa a "en riesgo" (es justo a quien conviene llamar); la marca
// VIP se sigue viendo aparte (`isVip`) y el filtro VIP lo encuentra igual.
// ─────────────────────────────────────────────────────────────────────────────

export const CLIENT_STATUSES = ["new", "active", "vip", "at_risk", "inactive"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/** Nadie queda "en riesgo" por frecuencia antes de una semana sin volver (dos visitas el mismo día no dan intervalo 0). */
export const MIN_AT_RISK_DAYS = 7;

const DAY_SECONDS = 86_400;

/** Lo que el estado necesita de un cliente. */
export interface ClientStatusInput {
  visitCount: number;
  firstVisitAt: Date | null;
  lastVisitAt: Date | null;
  totalSpentCents: number;
  /** VIP manual. */
  vip: boolean;
  createdAt: Date;
}

/** VIP manual o por reglas. */
export function isVip(c: Pick<ClientStatusInput, "vip" | "visitCount" | "totalSpentCents">, rules: ClientStatusRules): boolean {
  return (
    c.vip ||
    (rules.vipMinVisits !== null && c.visitCount >= rules.vipMinVisits) ||
    (rules.vipMinSpentCents !== null && c.totalSpentCents >= rules.vipMinSpentCents)
  );
}

/** Umbral de "en riesgo" en segundos para este cliente. */
function atRiskThresholdSeconds(c: ClientStatusInput, rules: ClientStatusRules): number {
  if (rules.atRiskMode === "frequency" && c.visitCount >= 2 && c.firstVisitAt && c.lastVisitAt) {
    const spanSeconds = (c.lastVisitAt.getTime() - c.firstVisitAt.getTime()) / 1000;
    return Math.max((rules.atRiskFrequencyFactor * spanSeconds) / (c.visitCount - 1), MIN_AT_RISK_DAYS * DAY_SECONDS);
  }
  return rules.atRiskAfterDays * DAY_SECONDS;
}

/** Estado del cliente al instante `now`. */
export function computeClientStatus(c: ClientStatusInput, rules: ClientStatusRules, now: Date = new Date()): ClientStatus {
  const reference = c.lastVisitAt ?? c.createdAt;
  const ageSeconds = (now.getTime() - reference.getTime()) / 1000;
  if (ageSeconds > rules.inactiveAfterDays * DAY_SECONDS) return "inactive";
  if (ageSeconds > atRiskThresholdSeconds(c, rules)) return "at_risk";
  if (isVip(c, rules)) return "vip";
  const since = c.firstVisitAt ?? c.createdAt;
  if ((now.getTime() - since.getTime()) / 1000 <= rules.newDays * DAY_SECONDS) return "new";
  return "active";
}

// ── SQL ─────────────────────────────────────────────────────────────────────

const nowParam = (now: Date) => sql`${now.toISOString()}::timestamptz`;

/** Expresión SQL "es VIP" (manual o por reglas). */
export function vipSql(rules: ClientStatusRules): SQL<boolean> {
  const parts: SQL[] = [sql`${clients.vip}`];
  if (rules.vipMinVisits !== null) parts.push(sql`${clients.visitCount} >= ${rules.vipMinVisits}`);
  if (rules.vipMinSpentCents !== null) parts.push(sql`${clients.totalSpentCents} >= ${rules.vipMinSpentCents}`);
  return sql<boolean>`(${sql.join(parts, sql` OR `)})`;
}

/** Expresión SQL del estado (mismo orden y bordes que `computeClientStatus`). */
export function clientStatusSql(rules: ClientStatusRules, now: Date = new Date()): SQL<ClientStatus> {
  const t = nowParam(now);
  const age = sql`EXTRACT(EPOCH FROM (${t} - COALESCE(${clients.lastVisitAt}, ${clients.createdAt})))`;
  const fixed = sql`${rules.atRiskAfterDays * DAY_SECONDS}::double precision`;
  const threshold =
    rules.atRiskMode === "frequency"
      ? sql`CASE WHEN ${clients.visitCount} >= 2 AND ${clients.firstVisitAt} IS NOT NULL AND ${clients.lastVisitAt} IS NOT NULL
             THEN GREATEST(
               ${rules.atRiskFrequencyFactor}::double precision * EXTRACT(EPOCH FROM (${clients.lastVisitAt} - ${clients.firstVisitAt}))::double precision / (${clients.visitCount} - 1),
               ${MIN_AT_RISK_DAYS * DAY_SECONDS}::double precision)
             ELSE ${fixed} END`
      : fixed;
  const since = sql`COALESCE(${clients.firstVisitAt}, ${clients.createdAt})`;
  return sql<ClientStatus>`(CASE
    WHEN ${age}::double precision > ${rules.inactiveAfterDays * DAY_SECONDS}::double precision THEN 'inactive'
    WHEN ${age}::double precision > ${threshold} THEN 'at_risk'
    WHEN ${vipSql(rules)} THEN 'vip'
    WHEN EXTRACT(EPOCH FROM (${t} - ${since}))::double precision <= ${rules.newDays * DAY_SECONDS}::double precision THEN 'new'
    ELSE 'active' END)`;
}
