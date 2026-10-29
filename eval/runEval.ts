import "dotenv/config";
import { listLocations } from "../src/modules/business";
import { getServices } from "../src/modules/catalog";
import { findOrCreateClientByPhone } from "../src/modules/clients";
import { bookAppointment } from "../src/modules/scheduling";
import type { AgentHistoryMessage, AgentTurnResult } from "../src/modules/whatsapp/agentContract";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { createAgentRunner, type ChatCompletionsClient, type ToolCallEvent } from "../src/modules/whatsapp/agent";
import { addDays, localDate, zonedInstant } from "../src/modules/whatsapp/agent/time";
import { seedDev } from "../scripts/seedDev";
import { createEphemeralDb, type EphemeralDb } from "../test/helpers/pgliteDb";
import { evaluate, loadCases, type EvalCase, type ObservedToolCall } from "./assertions";

// ─────────────────────────────────────────────────────────────────────────────
// Evals del agente (puerto de legacy/eval/correrEval.ts). Corre el `AgentRunner` REAL
// contra OpenAI real sobre el negocio demo de `seed:dev` (estética, dos sucursales) en un
// PGlite en memoria, con transcripciones fijas (eval/transcripts/*.json) y aserciones
// laxas: ¿eligió la tool correcta?, ¿no inventó precios ni horarios?, ¿pasó a una persona
// cuando correspondía?, ¿usó el año correcto? Es el ángulo de CALIDAD que ningún test
// determinista cubre.
//
//   npm run eval                      (necesita OPENAI_API_KEY; cuesta tokens)
//   EVAL_CASE=reschedule npm run eval (solo los casos cuyo nombre contiene el texto)
//   EVAL_REPEAT=3 npm run eval        (cada caso 3 veces: mide la tasa de acierto)
//   EVAL_VERBOSE=1 npm run eval       (muestra la respuesta de los casos que fallan)
//   EVAL_DRY_RUN=1 npm run eval       (sin OpenAI: solo verifica el arnés y el seed)
//
// No corre en `npm test`. Nunca toca una base real: el seed va a un PGlite efímero (no al
// de PGLITE_DIR ni a DATABASE_URL). El agente no manda nada por WhatsApp: solo devuelve
// el resultado del turno.
//
// "Ahora" es el próximo martes a las 09:00 de Costa Rica (o hoy, si es martes): así
// "mañana" siempre cae en un día con atención en las dos sucursales y los casos no
// dependen del día en que se corran.
// ─────────────────────────────────────────────────────────────────────────────

const TZ = "America/Costa_Rica";
const CLIENT_PHONE = "+50688887777";
const CLIENT_NAME = "Marco Jiménez";

function evalNow(): Date {
  let date = localDate(new Date(), TZ);
  const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
  while (weekday(date) !== 2) date = addDays(date, 1);
  return zonedInstant(date, "09:00", TZ);
}

interface CaseWorld {
  businessId: string;
  clientId: string;
  escazu: string;
  serviceId: (name: string) => string;
}

async function prepare(db: EphemeralDb["db"], c: EvalCase, now: Date): Promise<CaseWorld> {
  const { businessId } = await seedDev(db, { now });
  const escazu = (await listLocations(db, businessId)).find((l) => l.name === "Escazú")?.id;
  if (!escazu) throw new Error("el seed ya no trae la sucursal Escazú");
  const services = await getServices(db, businessId);
  const serviceId = (name: string) => {
    const s = services.find((x) => x.name === name);
    if (!s) throw new Error(`el seed no trae el servicio "${name}"`);
    return s.id;
  };
  const { client } = await findOrCreateClientByPhone(db, businessId, { phone: CLIENT_PHONE, name: CLIENT_NAME, source: "WhatsApp" });
  const today = localDate(now, TZ);
  for (const s of c.seedAppointments ?? []) {
    await bookAppointment(db, businessId, {
      locationId: escazu,
      clientId: client.id,
      serviceIds: [serviceId(s.service)],
      staffId: "any",
      startsAt: zonedInstant(addDays(today, s.inDays), s.time, TZ),
      channel: "whatsapp_ai",
      now,
    });
  }
  return { businessId, clientId: client.id, escazu, serviceId };
}

/**
 * `EVAL_DRY_RUN=1`: un modelo de mentira que siempre contesta lo mismo, sin OpenAI. Sirve
 * para verificar el arnés (seed, citas sembradas, runner) sin gastar tokens; las
 * aserciones no se evalúan.
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

async function runCase(db: EphemeralDb["db"], c: EvalCase, now: Date): Promise<string[]> {
  const world = await prepare(db, c, now);
  const calls: ObservedToolCall[] = [];
  const runner = createAgentRunner({
    onToolCall: (e: ToolCallEvent) => calls.push({ name: e.name, args: e.args }),
    ...(DRY_RUN ? { openai: dryRunClient } : {}),
  });
  const previous = c.history ?? [];
  // El historial es de hoy, un minuto entre mensajes, terminando justo antes del turno.
  const history: AgentHistoryMessage[] = [
    ...previous.map((m, i) => ({ role: m.role, text: m.text, at: new Date(now.getTime() - (previous.length - i + 1) * 60_000) })),
    { role: "user", text: c.user, at: now },
  ];
  let result: AgentTurnResult;
  try {
    result = await runner(db, {
      businessId: world.businessId,
      conversationId: "00000000-0000-4000-8000-0000000000e1",
      clientId: world.clientId,
      clientPhone: CLIENT_PHONE,
      clientName: CLIENT_NAME,
      locationId: c.channel === "all" ? null : world.escazu,
      history,
      now,
    });
  } catch (e) {
    return [`error al correr el agente: ${e instanceof Error ? e.message : String(e)}`];
  }
  if (DRY_RUN) return result.replies[0]?.text === "(dry run)" ? [] : ["el runner no devolvió la respuesta del modelo de mentira"];
  const failures = evaluate(c.expect, result, calls, localDate(now, TZ).slice(0, 4), world.serviceId);
  if (failures.length && process.env.EVAL_VERBOSE) {
    failures.push(`respuesta: ${result.replies.map((r) => r.text).join(" ⏎ ")}`);
  }
  return failures;
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY && !DRY_RUN) {
    console.error("❌ Falta OPENAI_API_KEY. Las evals llaman a OpenAI real: definila en .env o en el entorno.");
    process.exitCode = 2;
    return;
  }
  const repeat = Math.max(1, Number(process.env.EVAL_REPEAT ?? "1") || 1);
  const filter = process.env.EVAL_CASE;
  const cases = loadCases().filter((c) => !filter || c.name.includes(filter));
  if (!cases.length) {
    console.error("❌ No hay casos de eval para correr.");
    process.exitCode = 2;
    return;
  }
  const now = evalNow();
  console.log(`\n🤖 Evals del agente — ${cases.length} caso(s) × ${repeat}, modelo ${process.env.OPENAI_MODEL ?? "gpt-4o-mini"}, "ahora" = ${now.toISOString()}\n`);

  // Una sola base para toda la corrida; el seed es idempotente (borra y recrea el negocio demo).
  const base = await createEphemeralDb();
  let green = 0;
  let flaky = 0;
  let red = 0;
  try {
    for (const c of cases) {
      const runs: string[][] = [];
      for (let i = 0; i < repeat; i++) runs.push(await runCase(base.db, c, now));
      const ok = runs.filter((f) => f.length === 0).length;
      const icon = ok === repeat ? "✅" : ok === 0 ? "❌" : "⚠️ ";
      if (ok === repeat) green++;
      else if (ok === 0) red++;
      else flaky++;
      console.log(`${icon} ${c.name}${repeat > 1 ? ` (${ok}/${repeat})` : ""}${c.description ? ` — ${c.description}` : ""}`);
      for (const f of new Set(runs.flat())) console.log(`     • ${f}`);
    }
  } finally {
    await base.close();
  }
  console.log(`\n✅ ${green}   ⚠️  ${flaky} inestable(s)   ❌ ${red}   (de ${cases.length})\n`);
  // exitCode y no process.exit(): deja que Node cierre sus sockets (process.exit con
  // conexiones abiertas revienta con un assert de libuv en Windows).
  process.exitCode = red + flaky > 0 ? 1 : 0;
}

void main();
