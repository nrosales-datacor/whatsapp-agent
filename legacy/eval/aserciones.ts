import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos, carga de casos y ASERCIONES de las evals del agente (ángulo 4 de
// TESTING.md). Vive aparte de `correrEval.ts` a propósito: ese módulo llama a
// OpenAI real y exige `OPENAI_API_KEY`, así que no se puede importar desde un
// test. Acá está toda la lógica pura, cubierta por `test/unit/evalHarness.test.ts`
// (determinista, sin red, corre en CI) — así un bug en las aserciones no se
// disfraza de "el agente falló".
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolObservada {
  nombre: string;
  args: Record<string, unknown>;
}

export interface Espera {
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
  /**
   * La respuesta NO debe contener NINGÚN monto de dinero. Es la política dura de
   * Selyon ("no damos precios ni plazos por chat") y el fallo más caro del bot:
   * un precio inventado compromete al negocio. Más robusto que `noContiene`, que
   * exigiría enumerar cada forma de escribir una cifra.
   */
  sinMonto?: boolean;
  /**
   * Una herramienta debe haberse llamado con estos argumentos exactos (comparados
   * como texto). Sirve para verificar que eligió el servicio correcto, no solo que
   * llamó a la herramienta correcta.
   */
  argIncluye?: { herramienta: string; args: Record<string, string | number> };
}

export interface CasoEval {
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
  /** Activa el add-on del fixture (upsell, 1.2). Default: sin add-on. */
  upsell?: boolean;
  espera: Espera;
}

/** Resultado de `correrAgente` en la forma mínima que miran las aserciones. */
export interface ResultadoObservado {
  respuesta: string;
  escalar: boolean;
  fueraDeAlcance: boolean;
  interactivo?: unknown;
}

// Formas de escribir un monto que el bot NUNCA debería producir (ver `sinMonto`).
// Se buscan cifras con símbolo/moneda o magnitudes ("500 mil", "un millón"), no
// cualquier número: "30 min", "8:00" y "2026" no son montos.
export const PATRONES_MONTO: RegExp[] = [
  /[₡$]\s?\d/,
  /\d[\d.,]*\s*(mil|millones?|mill[oó]n)\b/i,
  /\d[\d.,]*\s*(colones|d[oó]lares|usd|crc)\b/i,
  /\b(un|una|dos|tres|cuatro|cinco|medio)\s+mill[oó]n/i,
];

/**
 * Aplica las aserciones de un caso y devuelve la lista de fallos (vacía = verde).
 * `anioActual` se pasa explícito (en vez de leer el reloj acá) para que el test
 * pueda ejercitar `fechaAnioActual` sin depender de la fecha en que corra.
 */
export function evaluar(
  espera: Espera,
  resultado: ResultadoObservado,
  tools: ToolObservada[],
  anioActual: string,
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
  if (espera.interactivo === false && resultado.interactivo)
    fallos.push("NO esperaba mensaje interactivo, pero lo hubo");

  for (const s of espera.contiene ?? [])
    if (!resp.includes(s.toLowerCase())) fallos.push(`la respuesta no contiene "${s}"`);
  if (espera.contieneAlguno && !espera.contieneAlguno.some((s) => resp.includes(s.toLowerCase())))
    fallos.push(`la respuesta no menciona ninguno de: ${espera.contieneAlguno.join(", ")}`);
  for (const s of espera.noContiene ?? [])
    if (resp.includes(s.toLowerCase())) fallos.push(`la respuesta no debería contener "${s}"`);

  if (espera.sinMonto) {
    // Se evalúa sobre la respuesta ORIGINAL (no en minúsculas) por los símbolos.
    const texto = resultado.respuesta || "";
    const patron = PATRONES_MONTO.find((p) => p.test(texto));
    if (patron) {
      const match = texto.match(patron);
      fallos.push(`la respuesta menciona un monto ("${match?.[0]?.trim()}") y no debería dar precios por chat`);
    }
  }

  if (espera.argIncluye) {
    const { herramienta, args } = espera.argIncluye;
    const llamadas = tools.filter((t) => t.nombre === herramienta);
    if (!llamadas.length) {
      fallos.push(`esperaba la herramienta "${herramienta}" (para revisar sus argumentos); se usaron: ${listaTools}`);
    } else {
      // Basta con que UNA de las llamadas a esa herramienta traiga todos los args.
      const alguna = llamadas.some((ll) =>
        Object.entries(args).every(([k, v]) => String(ll.args?.[k] ?? "") === String(v)),
      );
      if (!alguna) {
        const vistos = llamadas.map((ll) => JSON.stringify(ll.args)).join(" | ");
        fallos.push(`"${herramienta}" no se llamó con ${JSON.stringify(args)}; se llamó con: ${vistos}`);
      }
    }
  }

  if (espera.fechaAnioActual) {
    for (const t of tools) {
      const fecha = t.args?.fecha;
      if (typeof fecha === "string" && /^\d{4}-/.test(fecha) && !fecha.startsWith(anioActual))
        fallos.push(`la herramienta "${t.nombre}" usó una fecha con año inválido: ${fecha} (año actual: ${anioActual})`);
    }
  }
  return fallos;
}

/** Carga todos los casos de `eval/transcripciones/*.json`, ordenados por nombre de archivo. */
export function cargarCasos(): CasoEval[] {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "transcripciones");
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

/** Nombres de herramienta mencionados por un caso (para validar que existan de verdad). */
export function herramientasMencionadas(espera: Espera): string[] {
  return [
    espera.herramienta,
    espera.herramientaNo,
    ...(espera.herramientaAlguna ?? []),
    espera.argIncluye?.herramienta,
  ].filter((n): n is string => typeof n === "string");
}
