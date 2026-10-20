import type { Conversacion, Repositorio, Tenant } from "../types";
import { enviarPushATenant, pushConfigurado } from "./push";
import { describirTexto, enmascararTelefono } from "../observabilidad/privacidad";

// ─────────────────────────────────────────────────────────────────────────────
// Aviso al operador de que un cliente necesita atención humana.
//   - Lo registra en consola (y el badge del panel ya lo muestra).
//   - Envía una notificación PUSH (Web Push) a los navegadores/celulares suscritos.
// ─────────────────────────────────────────────────────────────────────────────

export async function notificarOperador(
  repo: Repositorio,
  tenant: Tenant,
  conv: Conversacion,
  texto: string,
): Promise<void> {
  console.log(
    `[panel] 🔔 ${tenant.id}: +${enmascararTelefono(conv.clienteWa)} necesita atención humana — aviso ${describirTexto(texto)}`,
  );

  if (!pushConfigurado()) return; // sin VAPID configurado, solo queda el log + badge

  const r = await enviarPushATenant(repo, tenant.id, {
    title: `💬 +${conv.clienteWa} quiere hablar`,
    body: texto.slice(0, 120),
    url: "/panel/",
    tag: conv.id, // una notificación por chat (no se acumulan)
  });
  if (r.enviadas === 0 && r.fallidas === 0) {
    console.log(`[push] ${tenant.nombre}: sin dispositivos suscritos todavía`);
  }
}
