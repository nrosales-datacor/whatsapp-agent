import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatCompletion } from "openai/resources/chat/completions";
import type { AgentTurnResult } from "../src/modules/whatsapp/agentContract";
import { createAgentRunner, type ChatCompletionsClient, type ToolCallEvent } from "../src/modules/whatsapp/agent";
import { agentModel } from "../src/modules/whatsapp/agent/config";
import { addDays, localDate, zonedInstant } from "../src/modules/whatsapp/agent/time";
import { createEphemeralDb, type EphemeralDb } from "../test/helpers/pgliteDb";
import { evaluate, loadCases, validateCase, type EvalCase, type ObservedToolCall } from "./assertions";
import {
  baselineNote,
  baselineRefusal,
  buildReport,
  caseIcon,
  caseResult,
  parseMaxCostUsd,
  parseMinPassRate,
  parseRepeat,
  percent,
  resultFileName,
  VERBOSE_REPLY_PREFIX,
  type CaseOutcome,
  type RunReport,
} from "./report";
import { buildTurnInput, EVAL_TZ, prepareWorld } from "./world";

// ─────────────────────────────────────────────────────────────────────────────
// Evals del agente (puerto de legacy/eval/correrEval.ts). Corre el `AgentRunner` REAL
// contra OpenAI real sobre negocios de prueba en un PGlite en memoria (eval/world.ts: el
// demo de `seed:dev` o uno nuevo de otra plantilla), con transcripciones fijas
// (eval/transcripts/*.json) y aserciones laxas: ¿eligió la tool correcta?, ¿no inventó
// precios ni horarios?, ¿pasó a una persona cuando correspondía?, ¿usó el año correcto?
// Es el ángulo de CALIDAD que ningún test determinista cubre. Guía: TESTING.md § 4.
//
//   npm run eval                        (necesita OPENAI_API_KEY de DESARROLLO; cuesta tokens)
//   EVAL_REPEAT=3 npm run eval          (cada caso 3 veces: mide la tasa de acierto)
//   EVAL_CASE=reschedule npm run eval   (solo los casos cuyo nombre contiene el texto)
//   EVAL_MIN_PASS_RATE=0.9              (tasa mínima por caso; los `critical` exigen 100 %)
//   EVAL_MAX_COST_USD=1                 (tope de gasto estimado por corrida; default 1)
//   EVAL_WRITE_BASELINE=1               (además guarda eval/baseline.json, si la corrida sirve)
//   EVAL_VERBOSE=1                      (muestra en consola la respuesta de los casos que fallan)
//   EVAL_DRY_RUN=1 npm run eval         (sin OpenAI: valida los casos, el seed y el runner)
//
// Sin OPENAI_API_KEY (y sin EVAL_DRY_RUN) NO corre nada: avisa que se saltaron y sale con
// 0, sin escribir resultados (no hay nada que reportar ni que fingir).
//
// Salida: resumen legible en consola + eval/results/<fecha>-<modelo>.json (gitignored).
// Código de salida: 0 si todos los casos llegan a su umbral; 1 si alguno queda debajo o el
// tope de gasto cortó la corrida; 2 si los casos o la configuración son inválidos.
//
// No corre en `npm test`. Nunca toca una base real: el seed va a un PGlite efímero (no al
// de PGLITE_DIR ni a DATABASE_URL). El agente no manda nada por WhatsApp ni sincroniza
// nada: solo devuelve el resultado del turno.
//
// "Ahora" es el próximo martes a las 09:00 de Costa Rica (o hoy, si es martes): así
// "mañana" siempre cae en un día con atención en todas las sucursales y los casos no
// dependen del día en que se corran.
// ─────────────────────────────────────────────────────────────────────────────

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(EVAL_DIR, "results");
const BASELINE_FILE = join(EVAL_DIR, "baseline.json");

function evalNow(): Date {
  let date = localDate(new Date(), EVAL_TZ);
  const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
  while (weekday(date) !== 2) date = addDays(date, 1);
  return zonedInstant(date, "09:00", EVAL_TZ);
}

/**
 * `EVAL_DRY_RUN=1`: un modelo de mentira que siempre contesta lo mismo, sin OpenAI. Sirve
 * para verificar el arnés (casos, seed de cada plantilla, citas sembradas, runner) sin
 * gastar tokens; las aserciones no se evalúan.
 */
const DRY_RUN = process.env.EVAL_DRY_RUN === "1";

const dryRunClient: ChatCompletionsClient = {
  chat: {
    completions: {
      create: async () =>
        ({
          id: "dry-run",
          object: "chat.completion",
          created: 0,
          model: "dry-run",
          choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content: "(dry run)", refusal: null } }],
        }) as ChatCompletion,
    },
  },
};

interface RunOutcome {
  failures: string[];
  usage: AgentTurnResult["usage"];
}

const NO_USAGE: AgentTurnResult["usage"] = { inputTokens: 0, outputTokens: 0, costMicros: 0 };

async function runCase(db: EphemeralDb["db"], c: EvalCase, now: Date): Promise<RunOutcome> {
  const world = await prepareWorld(db, c, now);
  const calls: ObservedToolCall[] = [];
  const runner = createAgentRunner({
    onToolCall: (e: ToolCallEvent) => calls.push({ name: e.name, args: e.args }),
    ...(DRY_RUN ? { openai: dryRunClient } : {}),
  });
  let result: AgentTurnResult;
  try {
    result = await runner(db, buildTurnInput(c, world, now));
  } catch (e) {
    return { failures: [`error al correr el agente: ${e instanceof Error ? e.message : String(e)}`], usage: NO_USAGE };
  }
  if (DRY_RUN) {
    return { failures: result.replies[0]?.text === "(dry run)" ? [] : ["el runner no devolvió la respuesta del modelo de mentira"], usage: result.usage };
  }
  const failures = evaluate(c.expect, result, calls, localDate(now, EVAL_TZ).slice(0, 4), world.serviceId);
  if (failures.length && process.env.EVAL_VERBOSE) failures.push(`${VERBOSE_REPLY_PREFIX}${result.replies.map((r) => r.text).join(" ⏎ ")}`);
  return { failures, usage: result.usage };
}

function readBaseline(): RunReport | null {
  if (!existsSync(BASELINE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as RunReport;
  } catch {
    console.warn("⚠️  eval/baseline.json no se pudo leer: se ignora la comparación.");
    return null;
  }
}

function writeJson(file: string, report: RunReport): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY && !DRY_RUN) {
    console.log(
      [
        "",
        "⏭️  Evals SALTADAS: no hay OPENAI_API_KEY en el entorno ni en .env.",
        "   No se corrió ningún caso ni se escribió ningún resultado (no hay nada que reportar).",
        "   Para correrlas: OPENAI_API_KEY=<key de DESARROLLO, nunca la de producción> EVAL_REPEAT=3 npm run eval",
        "   Para validar el arnés sin gastar tokens: EVAL_DRY_RUN=1 npm run eval",
        "",
      ].join("\n"),
    );
    process.exitCode = 0;
    return;
  }

  let repeat: number;
  let minPassRate: number;
  let maxCostUsd: number;
  try {
    repeat = parseRepeat(process.env.EVAL_REPEAT);
    minPassRate = parseMinPassRate(process.env.EVAL_MIN_PASS_RATE);
    maxCostUsd = parseMaxCostUsd(process.env.EVAL_MAX_COST_USD);
  } catch (e) {
    console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
    return;
  }
  const filter = process.env.EVAL_CASE?.trim() || null;
  const all = loadCases();
  const invalid = all.flatMap(validateCase);
  if (invalid.length) {
    console.error(`❌ Casos de eval inválidos (corregilos antes de gastar tokens):\n${invalid.map((e) => `   • ${e}`).join("\n")}`);
    process.exitCode = 2;
    return;
  }
  const cases = all.filter((c) => !filter || c.name.includes(filter));
  if (!cases.length) {
    console.error("❌ No hay casos de eval para correr.");
    process.exitCode = 2;
    return;
  }
  const model = DRY_RUN ? "dry-run" : agentModel();
  const now = evalNow();
  const baseline = DRY_RUN ? null : readBaseline();
  const totalRuns = cases.length * repeat;
  const capMicros = maxCostUsd * 1_000_000;
  console.log(
    `\n🤖 Evals del agente — ${cases.length} caso(s) × ${repeat}, modelo ${model}, "ahora" = ${now.toISOString()}` +
      (DRY_RUN ? "  [DRY RUN: sin OpenAI, sin aserciones]" : `\n   Umbral: ${percent(minPassRate)} por caso (críticos: 100 %) · tope de gasto: US$${maxCostUsd}`) +
      "\n",
  );

  // Una sola base para toda la corrida: cada caso siembra su propio negocio (el de
  // estética es idempotente: borra y recrea el demo).
  const base = await createEphemeralDb();
  const outcomes: CaseOutcome[] = cases.map((c) => ({ name: c.name, critical: c.critical === true, runs: 0, passed: 0, failures: [] }));
  const tokens = { input: 0, output: 0 };
  let costMicros = 0;
  let done = 0;
  let capped = false;
  let projectionWarned = false;
  try {
    for (const [index, c] of cases.entries()) {
      const outcome = outcomes[index];
      for (let i = 0; i < repeat && !capped; i++) {
        // El tope se mira ENTRE turnos: un turno en curso no se corta a la mitad.
        if (costMicros >= capMicros) {
          capped = true;
          break;
        }
        const run = await runCase(base.db, c, now);
        outcome.runs++;
        if (run.failures.length === 0) outcome.passed++;
        outcome.failures.push(...run.failures);
        costMicros += run.usage.costMicros;
        tokens.input += run.usage.inputTokens;
        tokens.output += run.usage.outputTokens;
        done++;
        const projected = (costMicros / done) * totalRuns;
        if (!projectionWarned && done >= 3 && projected > capMicros) {
          projectionWarned = true;
          console.log(`⚠️  Al ritmo actual la corrida costaría ~US$${(projected / 1_000_000).toFixed(2)}: el tope (US$${maxCostUsd}) la va a cortar antes de terminar.`);
        }
      }
      if (outcome.runs === 0) break;
      const shown = caseResult(outcome, minPassRate);
      const rate = repeat > 1 || outcome.runs !== repeat ? ` (${outcome.passed}/${outcome.runs})` : "";
      console.log(`${caseIcon(shown)} ${c.name}${c.critical ? " [crítico]" : ""}${rate}${baselineNote(c.name, baseline)}${c.description ? ` — ${c.description}` : ""}`);
      for (const f of new Set(outcome.failures)) console.log(`     • ${f}`);
      if (capped) break;
    }
  } finally {
    await base.close();
  }

  const report = buildReport({ date: new Date(), model, repeat, minPassRate, filter, maxCostUsd, costMicros, tokens, outcomes });
  const { summary } = report;
  console.log(
    `\n✅ ${summary.ok} ${DRY_RUN ? "con el arnés OK" : "sobre el umbral"}   ❌ ${summary.belowThreshold} ${DRY_RUN ? "con el arnés roto" : "bajo el umbral"}` +
      (summary.notRun ? `   ⏭️  ${summary.notRun} sin correr (tope de gasto)` : "") +
      `   (de ${summary.cases})` +
      (DRY_RUN ? "" : `\n💸 Costo estimado: US$${report.costUsd.toFixed(4)} (${tokens.input} tokens de entrada, ${tokens.output} de salida)`),
  );
  if (capped) console.log(`🛑 Se alcanzó el tope de gasto (EVAL_MAX_COST_USD=${maxCostUsd}): la corrida quedó incompleta.`);

  if (DRY_RUN) {
    console.log("\n(dry run: el arnés funciona; no se escribió ningún resultado)\n");
  } else {
    const file = join(RESULTS_DIR, resultFileName(new Date(report.date), model));
    writeJson(file, report);
    console.log(`📄 Resultado: ${relative(process.cwd(), file)}`);
    if (process.env.EVAL_WRITE_BASELINE === "1") {
      const refusal = baselineRefusal(report);
      if (refusal) console.log(`⚠️  No se guardó la línea base: ${refusal}.`);
      else {
        writeJson(BASELINE_FILE, report);
        console.log(`📌 Línea base guardada en ${relative(process.cwd(), BASELINE_FILE)} (commiteala junto con el cambio que la motivó).`);
      }
    }
    console.log("");
  }
  // exitCode y no process.exit(): deja que Node cierre sus sockets (process.exit con
  // conexiones abiertas revienta con un assert de libuv en Windows).
  process.exitCode = report.passed ? 0 : 1;
}

void main();
