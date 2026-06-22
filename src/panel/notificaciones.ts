import type { Conversacion, Repositorio, Tenant } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Aviso al operador de que un cliente necesita atención humana.
//   Fase 1: lo registra en consola (y el badge del panel ya lo muestra).
//   Fase 2: enviará una notificación PUSH (Web Push) a los navegadores suscritos.
// ─────────────────────────────────────────────────────────────────────────────

export async function notificarOperador(
  repo: Repositorio,
  tenant: Tenant,
  conv: Conversacion,
  texto: string,
): Promise<void> {
  console.log(
    `[panel] 🔔 ${tenant.nombre}: +${conv.clienteWa} necesita atención humana — "${texto.slice(0, 60)}"`,
  );
  // Fase 2: notificación push real a repo.listarPushSubs(tenant.id).
  void repo;
}
