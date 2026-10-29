import { APIConnectionError, APIError } from "openai";

// ─────────────────────────────────────────────────────────────────────────────
// ¿Vale la pena reintentar este error más tarde? (E7, revisión pre-venta 2026-10)
//
// POR QUÉ: `responderEntrante` atrapaba CUALQUIER excepción del turno, le mandaba al
// cliente "Disculpá, tuvimos un problemita" y el job quedaba "hecho" — así que el
// backoff de la cola durable (`marcarFalloOReintentar`) nunca corría. Un 429 de
// OpenAI o un hipo de 30 s de Meta, que se resuelven solos, terminaban en un cliente
// sin respuesta y un operador interrumpido. Ahora, ante un error TRANSITORIO y si al
// job le quedan intentos, el turno se relanza para que la cola lo reintente con
// backoff; la disculpa + aviso al operador quedan solo para el último intento.
//
// Transitorio = el mismo pedido, repetido en unos segundos, probablemente funcione:
//   - OpenAI: sin conexión / timeout (`APIConnectionError`, incluye el timeout), 408,
//     409 (lock), 429 de rate limit y 5xx. NO el 429 `insufficient_quota` (la cuenta
//     se quedó sin saldo: reintentar no lo arregla) ni un 400/401/404.
//   - Graph (WhatsApp): `ErrorGraph` con `transitorio: true` (red/timeout, 408, 429,
//     5xx, o un código de Meta marcado como transitorio — ver whatsapp/client.ts).
//     Se lee por la marca, sin importar la clase, para no acoplar este módulo al
//     cliente de WhatsApp.
//
// Se recorre la cadena de `cause` (mismo criterio que `esChoqueDeEmpleado`): un
// error envuelto por otra capa no debe perder su clasificación.
// ─────────────────────────────────────────────────────────────────────────────

export function esErrorTransitorio(e: unknown): boolean {
  let actual: unknown = e;
  for (let i = 0; actual && i < 5; i++) {
    if (actual instanceof APIConnectionError) return true;
    if (actual instanceof APIError) {
      if ((actual as APIError).code === "insufficient_quota") return false;
      const status = actual.status;
      return status === 408 || status === 409 || status === 429 || (typeof status === "number" && status >= 500);
    }
    const marca = (actual as { transitorio?: unknown }).transitorio;
    if (typeof marca === "boolean") return marca;
    actual = (actual as { cause?: unknown }).cause;
  }
  return false;
}
