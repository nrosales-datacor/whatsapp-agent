import type { MensajeConversacion } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Ventana de sesión de WhatsApp (Meta, Carril D 0.3): solo se puede mandar texto
// libre dentro de las 24 h posteriores al último mensaje ENTRANTE del cliente.
// Fuera de esa ventana hace falta una plantilla aprobada (enviarPlantilla en
// whatsapp/client.ts). Este helper deriva el estado a partir del historial de la
// conversación, sin persistir nada nuevo.
// ─────────────────────────────────────────────────────────────────────────────

export const VENTANA_24H_MS = 24 * 60 * 60 * 1000;

export interface EstadoVentana {
  ventanaAbierta: boolean;
  /** ISO de cuándo cierra la ventana; null = el cliente nunca escribió. */
  ventanaCierraEn: string | null;
}

/** Deriva si la ventana de 24h está abierta a partir de los mensajes de la conversación. */
export function calcularVentana(mensajes: Pick<MensajeConversacion, "rol" | "creadoEn">[]): EstadoVentana {
  let ultimoEntranteEn: string | null = null;
  for (let i = mensajes.length - 1; i >= 0; i--) {
    if (mensajes[i].rol === "user") {
      ultimoEntranteEn = mensajes[i].creadoEn;
      break;
    }
  }
  if (!ultimoEntranteEn) return { ventanaAbierta: false, ventanaCierraEn: null };

  const cierraEn = new Date(new Date(ultimoEntranteEn).getTime() + VENTANA_24H_MS);
  return { ventanaAbierta: Date.now() < cierraEn.getTime(), ventanaCierraEn: cierraEn.toISOString() };
}
