import type { Executor } from "../../platform/db/scope";

// ─────────────────────────────────────────────────────────────────────────────
// Contrato entre el pipeline de mensajes de WhatsApp (ingesta, cola, envío) y el agente
// de IA. El pipeline arma el turno y aplica el resultado; el agente decide qué contestar
// y opera la agenda con los servicios del núcleo. La composición (src/jobs.ts) inyecta
// el `AgentRunner` real; sin él, el pipeline usa uno que pasa la conversación a una persona.
// ─────────────────────────────────────────────────────────────────────────────

/** Un mensaje del historial, del más viejo al más nuevo (incluye el o los mensajes nuevos). */
export interface AgentHistoryMessage {
  role: "user" | "assistant";
  text: string;
  at: Date;
  /** true si lo escribió una persona del negocio desde la bandeja. */
  byHuman?: boolean;
}

export interface AgentTurnInput {
  businessId: string;
  conversationId: string;
  clientId: string;
  clientPhone: string;
  clientName: string | null;
  /** Sucursal del canal; null = el número atiende todas y el agente pregunta cuál. */
  locationId: string | null;
  history: AgentHistoryMessage[];
  now: Date;
  /**
   * Crecimiento activo para este negocio (I6: lo permite el plan Y el dueño lo activó). Sin
   * el campo, nada: el agente no registra cotizaciones ni ofrece upsell.
   */
  growth?: AgentGrowth;
}

/** Lo de crecimiento que el agente hace en el turno. */
export interface AgentGrowth {
  /** Registrar cotizaciones (`record_quote`) para el rescate. */
  quoteRecovery: boolean;
  /** Reglas de upsell "a quien agenda X, ofrecele Y" (vacío = sin upsell). */
  upsellRules: { serviceId: string; suggestServiceId: string }[];
}

export type AgentAction =
  | { type: "handoff"; reason: string }
  | { type: "appointment_booked"; appointmentId: string }
  | { type: "appointment_rescheduled"; appointmentId: string }
  | { type: "appointment_cancelled"; appointmentId: string }
  | { type: "appointment_service_added"; appointmentId: string };

export interface AgentReply {
  text: string;
  /** Botones de respuesta rápida (WhatsApp permite hasta 3). */
  buttons?: { id: string; title: string }[];
}

export interface AgentTurnResult {
  replies: AgentReply[];
  actions: AgentAction[];
  usage: { inputTokens: number; outputTokens: number; costMicros: number };
}

export type AgentRunner = (executor: Executor, input: AgentTurnInput) => Promise<AgentTurnResult>;
