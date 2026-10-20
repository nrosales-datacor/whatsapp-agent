import { APIConnectionError, APIError } from "openai";

// ─────────────────────────────────────────────────────────────────────────────
// ¿Vale la pena reintentar este error más tarde?
//
// POR QUÉ: si un job atrapa CUALQUIER excepción y se da por "hecho", el backoff de la
// cola durable nunca corre: un 429 de OpenAI o un hipo de 30 s de Meta, que se resuelven
// solos, terminan en un cliente sin respuesta. Ante un error TRANSITORIO, y si al job le
// quedan intentos, se relanza para que la cola lo reintente con backoff; el manejo del
// fallo definitivo queda solo para el último intento.
//
// Transitorio = el mismo pedido, repetido en unos segundos, probablemente funcione:
//   - OpenAI: sin conexión / timeout (`APIConnectionError`, incluye el timeout), 408,
//     409 (lock), 429 de rate limit y 5xx. NO el 429 `insufficient_quota` (la cuenta se
//     quedó sin saldo: reintentar no lo arregla) ni un 400/401/404.
//   - Cualquier otro error con la marca `transient: boolean` (p. ej. el error de Graph
//     del módulo WhatsApp: red/timeout, 408, 429, 5xx). Se lee por la marca, sin importar
//     la clase, para no acoplar este módulo a cada cliente HTTP.
//
// Se recorre la cadena de `cause`: un error envuelto por otra capa no debe perder su
// clasificación.
// ─────────────────────────────────────────────────────────────────────────────

export function isTransientError(e: unknown): boolean {
  let current: unknown = e;
  for (let i = 0; current && i < 5; i++) {
    if (current instanceof APIConnectionError) return true;
    if (current instanceof APIError) {
      if ((current as APIError).code === "insufficient_quota") return false;
      const status = current.status;
      return status === 408 || status === 409 || status === 429 || (typeof status === "number" && status >= 500);
    }
    const flag = (current as { transient?: unknown }).transient;
    if (typeof flag === "boolean") return flag;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
