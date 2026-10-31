import { numberFromEnv, rateAlert } from "../../platform/observability/rateAlert";

// ─────────────────────────────────────────────────────────────────────────────
// Alertas a la plataforma por TASA de fallos del turno de WhatsApp (el «bot mudo»):
//
//   • `llm_unavailable` (critical): el agente no pudo responder (OpenAI caído, sin saldo,
//     key revocada, timeout…). Cuenta los fallos DEFINITIVOS del turno — los que terminan
//     en la disculpa al cliente —, incluido el error transitorio del último intento: en ese
//     caso `shouldRetry` ya no relanza, el job termina «bien» y el DLQ nunca lo ve.
//   • `whatsapp_send_failing` (critical): Meta rechazó el envío de la respuesta por algo
//     que NO es el token (cuenta bloqueada, 403, 368, 131031, número sin permiso…). El
//     token inválido (401 / código 190) ya tiene su propia alerta por negocio
//     (`whatsapp_token_invalid`, ./channels.ts): acá no se cuenta para no duplicar.
//
// Cada fallo cuenta dos veces: en la ventana del NEGOCIO (su bot está mudo) y en la
// GLOBAL (posible caída del proveedor para todos), con umbrales propios. Con un solo
// negocio fallando, primero sale la del negocio; si sigue, la global avisa que ya no es
// un caso aislado. Umbrales en .env.example (`ALERTS_LLM_*`, `ALERTS_SEND_*`) y DEPLOY.md §22.
// ─────────────────────────────────────────────────────────────────────────────

export const LLM_UNAVAILABLE_ALERT = "llm_unavailable";
export const WHATSAPP_SEND_FAILING_ALERT = "whatsapp_send_failing";

interface Thresholds {
  perBusiness: number;
  global: number;
  windowMs: number;
}

function llmThresholds(): Thresholds {
  return {
    perBusiness: numberFromEnv("ALERTS_LLM_FAILURES", 5, 1),
    global: numberFromEnv("ALERTS_LLM_FAILURES_GLOBAL", 10, 1),
    windowMs: numberFromEnv("ALERTS_LLM_WINDOW_MIN", 10, 1) * 60_000,
  };
}

function sendThresholds(): Thresholds {
  return {
    perBusiness: numberFromEnv("ALERTS_SEND_FAILURES", 5, 1),
    global: numberFromEnv("ALERTS_SEND_FAILURES_GLOBAL", 10, 1),
    windowMs: numberFromEnv("ALERTS_SEND_WINDOW_MIN", 10, 1) * 60_000,
  };
}

function track(type: string, businessId: string, t: Thresholds, texts: { business: string; global: string }, now: number): boolean {
  const windowMin = Math.round(t.windowMs / 60_000);
  const forBusiness = rateAlert(
    {
      type,
      tenantId: businessId,
      severity: "critical",
      threshold: t.perBusiness,
      windowMs: t.windowMs,
      message: (count) => `${count} ${texts.business} en ${windowMin} min.`,
    },
    now,
  );
  const global = rateAlert(
    {
      type,
      tenantId: null,
      severity: "critical",
      threshold: t.global,
      windowMs: t.windowMs,
      message: (count) => `${count} ${texts.global} en ${windowMin} min, sumando todos los negocios.`,
      data: { lastBusinessId: businessId },
    },
    now,
  );
  return forBusiness || global;
}

/** Un turno del agente que terminó sin respuesta (fallo definitivo). Devuelve true si salió una alerta. */
export function trackAgentFailure(businessId: string, now: number = Date.now()): boolean {
  return track(
    LLM_UNAVAILABLE_ALERT,
    businessId,
    llmThresholds(),
    {
      business: "turnos del agente fallaron (el cliente recibió la disculpa): ¿OpenAI caído, sin saldo o key revocada?",
      global: "turnos del agente fallaron: posible caída o falta de saldo de OpenAI para toda la plataforma",
    },
    now,
  );
}

/** ¿El error es el de token rechazado por Meta (ya tiene su alerta propia)? Sigue la cadena de `cause`. */
function isTokenError(e: unknown): boolean {
  let current: unknown = e;
  for (let i = 0; current && i < 5; i++) {
    if ((current as { tokenInvalid?: unknown }).tokenInvalid === true) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Un envío de la respuesta del bot que Meta rechazó (fallo definitivo). Los de token no
 * cuentan. Devuelve true si salió una alerta.
 */
export function trackReplySendFailure(businessId: string, error: unknown, now: number = Date.now()): boolean {
  if (isTokenError(error)) return false;
  return track(
    WHATSAPP_SEND_FAILING_ALERT,
    businessId,
    sendThresholds(),
    {
      business: "respuestas del bot no se pudieron enviar por WhatsApp (no es el token): ¿cuenta o número bloqueado en Meta?",
      global: "respuestas del bot no se pudieron enviar por WhatsApp: posible problema general con Meta",
    },
    now,
  );
}
