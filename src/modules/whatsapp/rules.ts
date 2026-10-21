// ─────────────────────────────────────────────────────────────────────────────
// Reglas de una conversación que no dependen de la base (portadas de
// legacy/src/whatsapp/{ventana,traspasoHumano}.ts):
//
//   • Ventana de 24 h de Meta: solo se puede mandar texto libre dentro de las 24 h
//     posteriores al último mensaje DEL CLIENTE. Fuera de ella hace falta una plantilla
//     aprobada (reapertura desde la bandeja, recordatorio).
//   • Vencimiento del modo humano: si una persona tomó la conversación pero nadie del
//     equipo actuó en N horas (ni un traspaso nuevo ni un mensaje desde la bandeja), la
//     conversación vuelve al bot cuando el cliente escribe de nuevo. Sin esto, un cliente
//     podía quedar sin respuesta para siempre.
// ─────────────────────────────────────────────────────────────────────────────

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WindowState {
  open: boolean;
  /** Cuándo cierra (o cerró); null si el cliente nunca escribió. */
  closesAt: Date | null;
}

/** Estado de la ventana a partir del último mensaje entrante del cliente. */
export function windowState(lastInboundAt: Date | null, now: Date = new Date()): WindowState {
  if (!lastInboundAt) return { open: false, closesAt: null };
  const closesAt = new Date(lastInboundAt.getTime() + WINDOW_MS);
  return { open: now.getTime() < closesAt.getTime(), closesAt };
}

/** Horas sin actividad del equipo tras las que el modo humano vence (0 = nunca). */
export function humanModeExpiryHours(): number {
  const raw = process.env.WHATSAPP_HUMAN_MODE_EXPIRES_HOURS;
  const n = raw !== undefined && raw !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 12;
}

/**
 * true si la conversación está en modo humano pero el equipo no actuó en las últimas
 * `hours` horas. Cuenta el traspaso (`humanSince`) y el último mensaje escrito desde la
 * bandeja; los mensajes del cliente no (si insiste cada hora, igual tiene que vencer). Sin
 * ninguna marca de tiempo no vence (no se le quita la conversación a nadie por falta de datos).
 */
export function humanModeExpired(
  conversation: { mode: string; humanSince: Date | null },
  lastHumanReplyAt: Date | null,
  now: Date = new Date(),
  hours: number = humanModeExpiryHours(),
): boolean {
  if (conversation.mode !== "human" || hours === 0) return false;
  const marks = [conversation.humanSince, lastHumanReplyAt].filter((d): d is Date => d instanceof Date).map((d) => d.getTime());
  if (marks.length === 0) return false;
  return now.getTime() - Math.max(...marks) >= hours * 3_600_000;
}
