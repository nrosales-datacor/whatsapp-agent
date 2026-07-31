import "dotenv/config";
import { correrAgente } from "../src/agent/runAgent";
import { RepositorioEnMemoria } from "../src/booking/inMemoryRepository";
import type { MensajeConversacion } from "../src/types";
import { crearTenantEval } from "./fixtureEval";
import { cargarCasos, evaluar, type CasoEval, type ToolObservada } from "./aserciones";

// ─────────────────────────────────────────────────────────────────────────────
// Evals del agente (ángulo 4 de TESTING.md). Corre `correrAgente` contra OpenAI
// REAL con un set de transcripciones fijas (eval/transcripciones/*.json) y aplica
// aserciones LAXAS: ¿eligió la herramienta correcta?, ¿respetó la política de no
// dar precios por chat?, ¿escaló ante lo desconocido?, ¿no inventó horarios/años?
// Es el ángulo de CALIDAD que ningún unit test determinista cubre.
//
// NO corre en cada push (cuesta tokens): es `npm run eval`, manual o nocturno.
// Necesita OPENAI_API_KEY en el entorno (o .env). NUNCA toca producción: usa un
// tenant de fixture (eval/fixtureEval.ts) y un repo en memoria.
//
// Los tipos y las aserciones viven en `eval/aserciones.ts` (con tests deterministas
// en `test/unit/evalHarness.test.ts`); acá queda solo la ejecución contra OpenAI.
//
// Cómo observamos qué herramienta usó el agente: `correrAgente` no expone la
// lista de tool_calls, así que espiamos `globalThis.fetch` y leemos (sobre un
// clon, sin consumir la respuesta que usa el SDK) los `tool_calls` que devuelve
// OpenAI. No modifica nada del flujo real.
// ─────────────────────────────────────────────────────────────────────────────

const CLIENTE_WA = "50688887777";

// ── Aislamiento de servicios externos que MUTAN estado real ──────────────────
// `import "dotenv/config"` carga el .env de desarrollo, que en las máquinas del
// equipo tiene credenciales REALES. Los casos de agenda llaman `agendar_cita`, que
// sincroniza a Google Calendar (`sincronizarCreacionGcal`) — sin esto, correr las
// evals crea eventos de verdad en el calendario del negocio y hay que borrarlos a
// mano (ya pasó una vez: ver la nota de verificación de C2.1 en el ROADMAP).
//
// Se pueden borrar acá porque tanto `googleCalendar.ts` como `whatsapp/client.ts`
// leen estas variables PEREZOSAMENTE (dentro de las funciones de envío, no al
// importar el módulo): al quedar sin definir, ambos módulos caen a su no-op.
// OPENAI_API_KEY se conserva a propósito: es el servicio que se está evaluando, y
// solo lee. La base de datos nunca entra en juego (el repo es en memoria).
for (const clave of [
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
  "GOOGLE_CALENDAR_ID",
  "WHATSAPP_ACCESS_TOKEN",
]) {
  delete process.env[clave];
}

// ── Espía de fetch: registra los tool_calls que devuelve OpenAI ──────────────
let toolsDelCaso: ToolObservada[] = [];
const fetchReal = globalThis.fetch;
globalThis.fetch = async (input: any, init?: any): Promise<Response> => {
  const res = await fetchReal(input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? input);
  if (url.includes("api.openai.com") && url.includes("/chat/completions")) {
    try {
      const data: any = await res.clone().json();
      for (const call of data?.choices?.[0]?.message?.tool_calls ?? []) {
        if (call?.function?.name) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            /* args ilegibles: se deja {} */
          }
          toolsDelCaso.push({ nombre: call.function.name, args });
        }
      }
    } catch {
      /* respuesta no-JSON (streaming/errores): se ignora para el espía */
    }
  }
  return res;
};

// ── Fechas relativas (en la zona del tenant) ─────────────────────────────────
const TZ = crearTenantEval().timezone;
function hoyISO(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(),
  );
}
function fechaEnDias(dias: number): string {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + dias);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    base,
  );
}

// ── Corrida de un caso ─────────────────────────────────────────────────────────
async function correrCaso(caso: CasoEval): Promise<string[]> {
  const tenant = crearTenantEval({ upsell: caso.upsell === true });
  const repo = new RepositorioEnMemoria();
  for (const s of caso.seedCitas ?? []) {
    await repo.crearCita({
      tenantId: tenant.id,
      clienteWa: CLIENTE_WA,
      clienteNombre: s.nombre ?? "Cliente Eval",
      servicioId: s.servicioId,
      fecha: fechaEnDias(s.enDias),
      hora: s.hora,
    });
  }
  const historial: MensajeConversacion[] = (caso.historial ?? []).map((m) => ({
    rol: m.rol,
    contenido: m.contenido,
    creadoEn: "2020-01-01T00:00:00.000Z",
  }));

  toolsDelCaso = [];
  try {
    const resultado = await correrAgente({ tenant, repo, clienteWa: CLIENTE_WA }, caso.usuario, historial, caso.imagen);
    return evaluar(caso.espera, resultado, toolsDelCaso, hoyISO().slice(0, 4));
  } catch (e) {
    return [`error al correr el agente: ${e instanceof Error ? e.message : String(e)}`];
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      "❌ Falta OPENAI_API_KEY. Las evals llaman a OpenAI real. Definila en .env o en el entorno y reintentá.",
    );
    process.exit(2);
  }

  const reps = Math.max(1, Number(process.env.EVAL_REPETICIONES ?? "1") || 1);
  const soloCaso = process.env.EVAL_CASO; // filtrar por nombre (substring), útil al iterar
  let casos = cargarCasos();
  if (soloCaso) casos = casos.filter((c) => c.nombre.includes(soloCaso));
  if (!casos.length) {
    console.error("❌ No hay casos de eval para correr.");
    process.exit(2);
  }

  console.log(
    `\n🤖 Evals del agente — ${casos.length} caso(s), ${reps} repetición(es) c/u, modelo ${process.env.OPENAI_MODEL ?? "gpt-4o-mini"}\n`,
  );

  let verdes = 0;
  let inestables = 0;
  let rojos = 0;

  for (const caso of casos) {
    const fallosPorRep: string[][] = [];
    for (let i = 0; i < reps; i++) fallosPorRep.push(await correrCaso(caso));
    const repsOk = fallosPorRep.filter((f) => f.length === 0).length;

    let icono: string;
    if (repsOk === reps) {
      icono = "✅";
      verdes++;
    } else if (repsOk === 0) {
      icono = "❌";
      rojos++;
    } else {
      icono = "⚠️ ";
      inestables++;
    }

    const sufijo = reps > 1 ? ` (${repsOk}/${reps} ok)` : "";
    console.log(`${icono} ${caso.nombre}${sufijo}${caso.descripcion ? ` — ${caso.descripcion}` : ""}`);
    // Mostrar los fallos únicos observados (de cualquier repetición) para diagnosticar.
    const fallosUnicos = [...new Set(fallosPorRep.flat())];
    for (const f of fallosUnicos) console.log(`     • ${f}`);
  }

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`✅ ${verdes}   ⚠️  ${inestables} inestable(s)   ❌ ${rojos}   (de ${casos.length})`);
  console.log(
    inestables
      ? "\nNota: ⚠️ = el agente pasó en unas repeticiones y falló en otras (no determinista). Subí EVAL_REPETICIONES para medir la tasa.\n"
      : "\n",
  );

  // Falla la corrida si algún caso no fue verde en TODAS sus repeticiones (para el job nocturno).
  // Se setea exitCode (no process.exit()) para que Node drene sus sockets keep-alive y termine
  // solo: llamar process.exit() con conexiones abiertas revienta con un assert de libuv en Windows.
  process.exitCode = rojos + inestables > 0 ? 1 : 0;
}

main();
