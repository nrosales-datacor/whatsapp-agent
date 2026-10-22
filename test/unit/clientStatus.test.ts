import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import { DEFAULT_CLIENT_STATUS_RULES, type ClientStatusRules } from "../../src/modules/business";
import { businesses } from "../../src/modules/business/schema";
import { computeClientStatus, isVip, type ClientStatusInput } from "../../src/modules/clients";
import { clients } from "../../src/modules/clients/schema";
import { clientStatusSql, MIN_AT_RISK_DAYS, vipSql } from "../../src/modules/clients/status";
import { createEphemeralDb } from "../helpers/pgliteDb";

// ─────────────────────────────────────────────────────────────────────────────
// Estado del cliente (src/modules/clients/status.ts): los bordes de cada regla con la
// versión en TypeScript, y la PARIDAD con la expresión SQL (la que filtra y cuenta la
// lista) sobre una grilla de casos en PGlite: las dos tienen que decir lo mismo siempre.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-10-22T18:00:00.000Z");
const DAY = 86_400_000;
const SECOND = 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const FIXED: ClientStatusRules = {
  ...DEFAULT_CLIENT_STATUS_RULES,
  newDays: 30,
  vipMinVisits: 10,
  vipMinSpentCents: 10_000_000,
  atRiskMode: "fixed",
  atRiskAfterDays: 60,
  inactiveAfterDays: 120,
};
const FREQUENCY: ClientStatusRules = { ...FIXED, atRiskMode: "frequency", atRiskFrequencyFactor: 2 };

function client(overrides: Partial<ClientStatusInput> = {}): ClientStatusInput {
  return { visitCount: 0, firstVisitAt: null, lastVisitAt: null, totalSpentCents: 0, vip: false, createdAt: ago(400 * DAY), ...overrides };
}

/** Cliente con `visits` visitas, la primera hace `first` y la última hace `last`. */
const visited = (visits: number, first: number, last: number, extra: Partial<ClientStatusInput> = {}) =>
  client({ visitCount: visits, firstVisitAt: ago(first), lastVisitAt: ago(last), ...extra });

const status = (c: ClientStatusInput, rules = FIXED) => computeClientStatus(c, rules, NOW);

test("inactivo: MÁS de inactiveAfterDays desde la última visita (el día justo no cuenta)", () => {
  assert.equal(status(visited(3, 200 * DAY, 120 * DAY)), "at_risk", "120 días justos: en riesgo, todavía no inactivo");
  assert.equal(status(visited(3, 200 * DAY, 120 * DAY + SECOND)), "inactive");
  assert.equal(status(visited(30, 900 * DAY, 121 * DAY, { vip: true })), "inactive", "un VIP que no vuelve también");
});

test("en riesgo (modo fijo): MÁS de atRiskAfterDays sin volver", () => {
  assert.equal(status(visited(3, 100 * DAY, 60 * DAY)), "active", "60 días justos: todavía activo");
  assert.equal(status(visited(3, 100 * DAY, 60 * DAY + SECOND)), "at_risk");
  assert.equal(status(visited(1, 61 * DAY, 61 * DAY)), "at_risk", "una sola visita");
});

test("en riesgo (modo frecuencia): relativo al intervalo promedio, con piso de una semana", () => {
  // 3 visitas en 80 días → cada 40 días; ×2 → en riesgo pasados 80 días sin volver.
  assert.equal(status(visited(3, 160 * DAY, 80 * DAY), FREQUENCY), "active");
  assert.equal(status(visited(3, 160 * DAY, 80 * DAY + SECOND), FREQUENCY), "at_risk");
  assert.equal(status(visited(3, 160 * DAY, 80 * DAY), FIXED), "at_risk", "el mismo cliente en modo fijo (60 días)");
  // Viene cada semana: a los 15 días ya está en riesgo (en modo fijo seguiría activo).
  assert.equal(status(visited(5, 43 * DAY, 15 * DAY), FREQUENCY), "at_risk");
  assert.equal(status(visited(5, 43 * DAY, 15 * DAY), FIXED), "active");
  // Dos visitas el mismo día: intervalo 0 → piso de MIN_AT_RISK_DAYS.
  assert.equal(MIN_AT_RISK_DAYS, 7);
  assert.equal(status(visited(2, 7 * DAY, 7 * DAY), FREQUENCY), "new", "7 días justos: no está en riesgo (y es nuevo)");
  assert.equal(status(visited(2, 7 * DAY + SECOND, 7 * DAY + SECOND), FREQUENCY), "at_risk");
  // Con menos de dos visitas no hay frecuencia: se usa atRiskAfterDays.
  assert.equal(status(visited(1, 60 * DAY, 60 * DAY), FREQUENCY), "active");
  assert.equal(status(visited(1, 60 * DAY + SECOND, 60 * DAY + SECOND), FREQUENCY), "at_risk");
});

test("sin visitas: la referencia es el alta (nuevo, en riesgo o inactivo)", () => {
  assert.equal(status(client({ createdAt: ago(10 * DAY) })), "new");
  assert.equal(status(client({ createdAt: ago(30 * DAY) })), "new", "30 días justos: sigue nuevo");
  assert.equal(status(client({ createdAt: ago(30 * DAY + SECOND) })), "active");
  assert.equal(status(client({ createdAt: ago(60 * DAY + SECOND) })), "at_risk");
  assert.equal(status(client({ createdAt: ago(120 * DAY + SECOND) })), "inactive");
});

test("VIP: manual, por visitas o por gasto (null = criterio apagado), y antes que nuevo", () => {
  assert.equal(status(visited(2, 40 * DAY, 5 * DAY, { vip: true })), "vip", "manual");
  assert.equal(status(visited(10, 300 * DAY, 5 * DAY)), "vip", "10 visitas");
  assert.equal(status(visited(9, 300 * DAY, 5 * DAY)), "active", "9 visitas");
  assert.equal(status(visited(1, 3 * DAY, 3 * DAY, { totalSpentCents: 10_000_000 })), "vip", "gasto justo en el umbral, aunque sea nuevo");
  assert.equal(status(visited(1, 3 * DAY, 3 * DAY, { totalSpentCents: 9_999_999 })), "new");
  const noVisitRule = { ...FIXED, vipMinVisits: null };
  assert.equal(status(visited(50, 300 * DAY, 5 * DAY), noVisitRule), "active", "criterio de visitas apagado");
  assert.equal(isVip(visited(50, 300 * DAY, 5 * DAY), noVisitRule), false);
  // Un VIP en riesgo: el estado es "en riesgo", la marca VIP sigue.
  const vipAtRisk = visited(12, 400 * DAY, 70 * DAY);
  assert.equal(status(vipAtRisk), "at_risk");
  assert.equal(isVip(vipAtRisk, FIXED), true);
});

test("nuevo: primera visita hace a lo sumo newDays; después, activo", () => {
  assert.equal(status(visited(1, 30 * DAY, 30 * DAY)), "new");
  assert.equal(status(visited(2, 30 * DAY + SECOND, 2 * DAY)), "active");
  // Un contacto viejo de WhatsApp que recién vino por primera vez es nuevo.
  assert.equal(status(visited(1, 2 * DAY, 2 * DAY, { createdAt: ago(300 * DAY) })), "new");
});

// ── Paridad TS ↔ SQL ────────────────────────────────────────────────────────

const base = await createEphemeralDb();
after(() => base.close());

test("paridad: la expresión SQL da el mismo estado y VIP que computeClientStatus en una grilla de casos", async () => {
  const { db } = base;
  const businessId = randomUUID();
  await db.insert(businesses).values({ id: businessId, slug: `paridad-${businessId.slice(0, 8)}`, name: "Paridad" });

  const lastOffsets = [0, 3 * DAY, 7 * DAY, 7 * DAY + SECOND, 15 * DAY, 30 * DAY, 30 * DAY + SECOND, 59 * DAY, 60 * DAY, 60 * DAY + SECOND, 80 * DAY, 80 * DAY + SECOND, 120 * DAY, 120 * DAY + SECOND, 400 * DAY];
  const spans = [0, 10 * DAY, 80 * DAY, 200 * DAY];
  const counts = [1, 2, 3, 10];
  const rows: (typeof clients.$inferInsert)[] = [];
  let i = 0;
  for (const last of lastOffsets) {
    for (const span of spans) {
      for (const visits of counts) {
        if (span > 0 && visits === 1) continue;
        i++;
        rows.push({
          businessId,
          name: `C${i}`,
          visitCount: visits,
          firstVisitAt: ago(last + span),
          lastVisitAt: ago(last),
          totalSpentCents: i % 7 === 0 ? 10_000_000 : i * 1000,
          vip: i % 11 === 0,
          createdAt: ago(last + span + 5 * DAY),
        });
      }
    }
  }
  // Sin visitas, con altas en los bordes.
  for (const created of [DAY, 30 * DAY, 30 * DAY + SECOND, 60 * DAY, 60 * DAY + SECOND, 120 * DAY, 120 * DAY + SECOND, 500 * DAY]) {
    for (const vip of [false, true]) rows.push({ businessId, name: `S${created}-${vip}`, createdAt: ago(created), vip });
  }
  await db.insert(clients).values(rows);

  const stored = await db.select().from(clients).where(eq(clients.businessId, businessId));
  assert.equal(stored.length, rows.length);
  const ruleSets: [string, ClientStatusRules][] = [
    ["fijo", FIXED],
    ["frecuencia", FREQUENCY],
    ["frecuencia ×1,5 sin VIP por gasto", { ...FREQUENCY, atRiskFrequencyFactor: 1.5, vipMinSpentCents: null }],
    ["sin VIP por reglas", { ...FIXED, vipMinVisits: null, vipMinSpentCents: null, newDays: 7 }],
  ];
  const seen = new Set<string>();
  for (const [label, rules] of ruleSets) {
    const computed = await db
      .select({ id: clients.id, status: clientStatusSql(rules, NOW), vip: vipSql(rules) })
      .from(clients)
      .where(eq(clients.businessId, businessId));
    const byId = new Map(computed.map((r) => [r.id, r]));
    for (const row of stored) {
      const sqlRow = byId.get(row.id);
      const expected = computeClientStatus(row, rules, NOW);
      seen.add(expected);
      assert.equal(sqlRow?.status, expected, `${label}: ${row.name} (${JSON.stringify({ v: row.visitCount, f: row.firstVisitAt, l: row.lastVisitAt })})`);
      assert.equal(Boolean(sqlRow?.vip), isVip(row, rules), `${label}: VIP de ${row.name}`);
    }
  }
  assert.deepEqual([...seen].sort(), ["active", "at_risk", "inactive", "new", "vip"], "la grilla recorre los cinco estados");
});
