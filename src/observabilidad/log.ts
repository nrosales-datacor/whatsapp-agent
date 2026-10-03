// ─────────────────────────────────────────────────────────────────────────────
// Logger estructurado (ROADMAP F14), SIN dependencias nuevas (nada de Winston/
// Pino — mismo criterio "sin deps" que el resto de observabilidad/*.ts).
//
// Imprime UNA línea JSON por evento a stdout: fácil de grepear/parsear en
// `pm2 logs` o cualquier colector externo, sin transporte propio.
//
// ADITIVO a propósito (ROADMAP F14, alcance recortado): convive con los
// `console.log`/`console.warn`/`console.error` sueltos que ya existen en el
// resto del repo (en particular `handleWebhook.ts`, el hot path del webhook) —
// esto NO los reemplaza, se usa solo en los puntos nuevos del ciclo de vida de
// un mensaje donde interesa poder buscar por `correlationId`.
// ─────────────────────────────────────────────────────────────────────────────

import { sanearCamposLog } from "./privacidad";

type Nivel = "info" | "warn" | "error";
type Campos = Record<string, unknown>;

function emitir(nivel: Nivel, evento: string, campos: Campos): void {
  const ts = new Date().toISOString();
  let linea: string;
  try {
    // Red de seguridad de datos personales (ver ./privacidad.ts): clienteWa/telefono
    // salen enmascarados y texto/contenido/respuesta solo con su longitud.
    linea = JSON.stringify({ ts, nivel, evento, ...sanearCamposLog(campos) });
  } catch (e) {
    // `campos` con algo no serializable (referencia circular, BigInt, etc.) no
    // debe tumbar el hot path del webhook por un error de logging.
    linea = JSON.stringify({
      ts,
      nivel: "error",
      evento: "log_serializacion_fallo",
      eventoOriginal: evento,
      error: String(e),
    });
  }
  if (nivel === "error") console.error(linea);
  else if (nivel === "warn") console.warn(linea);
  else console.log(linea);
}

export const log = {
  info: (evento: string, campos: Campos = {}): void => emitir("info", evento, campos),
  warn: (evento: string, campos: Campos = {}): void => emitir("warn", evento, campos),
  error: (evento: string, campos: Campos = {}): void => emitir("error", evento, campos),
};
