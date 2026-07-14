import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { correrAgente } from "../src/agent/runAgent";
import { RepositorioEnMemoria } from "../src/booking/inMemoryRepository";
import type { MensajeConversacion } from "../src/types";
import { crearTenantEval } from "./fixtureEval";

// ─────────────────────────────────────────────────────────────────────────────
// Evals del agente (ángulo 4 de TESTING.md). Corre `correrAgente` contra OpenAI
// REAL con un set de transcripciones fijas (eval/transcripciones/*.json) y aplica
// aserciones LAXAS: ¿eligió la herramienta correcta?, ¿usó el precio del prompt?,
// ¿escaló ante lo desconocido?, ¿no inventó horarios/años? Es el ángulo de
// CALIDAD que ningún unit test determinista cubre.
//
// NO corre en cada push (cuesta tokens): es `npm run eval`, manual o nocturno.
// Necesita OPENAI_API_KEY en el entorno (o .env). NUNCA toca producción: usa un
// tenant de fixture y un repo en memoria.
//
// Cómo observamos qué herramienta usó el agente: `correrAgente` no expone la
// lista de tool_calls, así que espiamos `globalThis.fetch` y leemos (sobre un
// clon, sin consumir la respuesta que usa el SDK) los `tool_calls` que devuelve
// OpenAI. No modifica nada del flujo real.
// ─────────────────────────────────────────────────────────────────────────────

interface ToolObservada {
  nombre: string;
  args: Record<string, unknown>;
}

interface Espera {
  /** Debe haberse invocado exactamente esta herramienta (al menos una vez). */
  herramienta?: string;
  /** Debe haberse invocado AL MENOS UNA de estas (p. ej. consultar_disponibilidad U ofrecer_horarios). */
  herramientaAlguna?: string[];
  /** NO debe haberse invocado esta herramienta. */
  herramientaNo?: string;
  /** No debe haberse invocado NINGUNA herramienta (respuesta directa de texto). */
  sinHerramienta?: boolean;
  /** El agente debe / no debe escalar a humano. */
  escala?: boolean;
  /** El agente debe / no debe marcar la respuesta como fuera de alcance. */
  fueraDeAlcance?: boolean;
  /** Debe / no debe haber producido un mensaje interactivo (lista de horarios). */
  interactivo?: boolean;
  /** La respuesta debe contener TODOS estos textos (case-insensitive). */
  contiene?: string[];
  /** La respuesta debe contener AL MENOS UNO de estos textos. */
  contieneAlguno?: string[];
  /** La respuesta NO debe contener ninguno de estos textos. */
  noContiene?: string[];
  /** Toda herramienta con un argumento `fecha` debe usar el año en curso (no inventar años). */
  fechaAnioActual?: boolean;
}

interface CasoEval {
  nombre: string;
  descripcion?: string;
  /** Turnos previos de la conversación (contexto). */
  historial?: { rol: "user" | "assistant"; contenido: string }[];
  /** Citas a sembrar en el repo antes de correr (para consultar/reprogramar/cancelar). */
  seedCitas?: { servicioId: string; enDias: number; hora: string; nombre?: string }[];
  /** Mensaje del cliente en este turno. */
  usuario: string;
  /** Foto adjunta (data URL) para probar la rama de visión. */
  imagen?: string;
  espera: Espera;
}

const AQUI = dirname(fileURLToPath(import.meta.url));
const CLIENTE_WA = "50688887777";

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

// ── Aserciones ───────────────────────────────────────────────────────────────
function evaluar(
  espera: Espera,
  resultado: { respuesta: string; escalar: boolean; fueraDeAlcance: boolean; interactivo?: unknown },
  tools: ToolObservada[],
): string[] {
  const fallos: string[] = [];
  const nombres = tools.map((t) => t.nombre);
  const resp = (resultado.respuesta || "").toLowerCase();
  const listaTools = nombres.length ? nombres.join(", ") : "(ninguna)";

  if (espera.herramienta && !nombres.includes(espera.herramienta))
    fallos.push(`esperaba la herramienta "${espera.herramienta}"; se usaron: ${listaTools}`);
  if (espera.herramientaAlguna && !espera.herramientaAlguna.some((t) => nombres.includes(t)))
    fallos.push(`esperaba alguna de [${espera.herramientaAlguna.join(", ")}]; se usaron: ${listaTools}`);
  if (espera.herramientaNo && nombres.includes(espera.herramientaNo))
    fallos.push(`NO esperaba la herramienta "${espera.herramientaNo}", pero se usó`);
  if (espera.sinHerramienta && nombres.length)
    fallos.push(`no esperaba herramientas, pero se usaron: ${listaTools}`);

  if (espera.escala === true && !resultado.escalar) fallos.push("esperaba que escalara a humano, no lo hizo");
  if (espera.escala === false && resultado.escalar) fallos.push("NO esperaba escalada, pero escaló");
  if (espera.fueraDeAlcance === true && !resultado.fueraDeAlcance) fallos.push("esperaba fuera de alcance, no lo marcó");
  if (espera.fueraDeAlcance === false && resultado.fueraDeAlcance)
    fallos.push("NO esperaba fuera de alcance, pero lo marcó");
  if (espera.interactivo === true && !resultado.interactivo)
    fallos.push("esperaba un mensaje interactivo (lista de horarios), no lo hubo");
  if (espera.interactivo === false && resultado.interactivo) fallos.push("NO esperaba mensaje interactivo, pero lo hubo");

  for (const s of espera.contiene ?? [])
    if (!resp.includes(s.toLowerCase())) fallos.push(`la respuesta no contiene "${s}"`);
  if (espera.contieneAlguno && !espera.contieneAlguno.some((s) => resp.includes(s.toLowerCase())))
    fallos.push(`la respuesta no menciona ninguno de: ${espera.contieneAlguno.join(", ")}`);
  for (const s of espera.noContiene ?? [])
    if (resp.includes(s.toLowerCase())) fallos.push(`la respuesta no debería contener "${s}"`);

  if (espera.fechaAnioActual) {
    const anio = hoyISO().slice(0, 4);
    for (const t of tools) {
      const fecha = t.args?.fecha;
      if (typeof fecha === "string" && /^\d{4}-/.test(fecha) && !fecha.startsWith(anio))
        fallos.push(`la herramienta "${t.nombre}" usó una fecha con año inválido: ${fecha} (año actual: ${anio})`);
    }
  }
  return fallos;
}

// ── Carga de casos ────────────────────────────────────────────────────────────
function cargarCasos(): CasoEval[] {
  const dir = join(AQUI, "transcripciones");
  const archivos = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const casos: CasoEval[] = [];
  for (const f of archivos) {
    const contenido = JSON.parse(readFileSync(join(dir, f), "utf8"));
    for (const c of Array.isArray(contenido) ? contenido : [contenido]) casos.push(c);
  }
  return casos;
}

// ── Corrida de un caso ─────────────────────────────────────────────────────────
async function correrCaso(caso: CasoEval): Promise<string[]> {
  const tenant = crearTenantEval();
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
    return evaluar(caso.espera, resultado, toolsDelCaso);
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

  console.log(`\n🤖 Evals del agente — ${casos.length} caso(s), ${reps} repetición(es) c/u, modelo ${process.env.OPENAI_MODEL ?? "gpt-4o-mini"}\n`);

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
