// ─────────────────────────────────────────────────────────────────────────────
// Logger estructurado, SIN dependencias (nada de Winston/Pino — mismo criterio "sin
// deps" que el resto de observability/*.ts).
//
// Imprime UNA línea JSON por evento a stdout: fácil de grepear/parsear en `pm2 logs` o
// cualquier colector externo, sin transporte propio. Convive con los `console.*`
// sueltos; se usa donde interesa poder buscar por campos (`correlationId`, `tenantId`…).
// ─────────────────────────────────────────────────────────────────────────────

import { sanitizeLogFields } from "./privacy";

type Level = "info" | "warn" | "error";
type Fields = Record<string, unknown>;

function emit(level: Level, event: string, fields: Fields): void {
  const ts = new Date().toISOString();
  let line: string;
  try {
    // Red de seguridad de datos personales (ver ./privacy.ts): teléfonos salen
    // enmascarados y textos/contenidos solo con su longitud.
    line = JSON.stringify({ ts, level, event, ...sanitizeLogFields(fields) });
  } catch (e) {
    // `fields` con algo no serializable (referencia circular, BigInt, etc.) no debe
    // tumbar el camino caliente por un error de logging.
    line = JSON.stringify({
      ts,
      level: "error",
      event: "log_serialization_failed",
      originalEvent: event,
      error: String(e),
    });
  }
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields: Fields = {}): void => emit("info", event, fields),
  warn: (event: string, fields: Fields = {}): void => emit("warn", event, fields),
  error: (event: string, fields: Fields = {}): void => emit("error", event, fields),
};
