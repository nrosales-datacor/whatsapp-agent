import { alertarPlataforma, olvidarAlerta } from "../observabilidad/alertas";

// ─────────────────────────────────────────────────────────────────────────────
// Detección de token de WhatsApp inválido/revocado por tenant.
//
// POR QUÉ: cuando Meta invalida el access token de un negocio (el dueño cambió la
// clave de Facebook, quitó la app del Business Manager, venció un token temporal),
// TODOS los envíos de ese tenant fallan con HTTP 401 / error Graph 190
// (OAuthException) — pero el error queda tragado en los `.catch` de
// `handleWebhook.ts` o como un job en error más del DLQ. El bot queda mudo y lo
// primero que se sabe es la queja del cliente. Esto lo hace visible al instante.
//
// `client.ts` llama a `registrarRespuestaGraph` en cada respuesta de Graph (sin
// cambiar su contrato: ni lo que devuelve ni lo que lanza). Una respuesta OK
// LIMPIA la marca: el token volvió a funcionar (el dueño lo reconectó).
//
// La marca vive en memoria del PROCESO que hizo el envío (el `worker` con
// `ROL=worker`, o el único proceso con `ROL=todo`); `/salud?detalle=1` la muestra
// en ese proceso. La alerta a la plataforma sale igual desde ahí, al momento.
// ─────────────────────────────────────────────────────────────────────────────

/** Código de error de Graph para un access token inválido, vencido o revocado. */
const CODIGO_GRAPH_TOKEN_INVALIDO = 190;

export interface TokenInvalido {
  tenantId: string;
  /** ISO de la primera falla de esta racha. */
  desde: string;
  /** ISO de la falla más reciente. */
  ultimaFalla: string;
  status: number;
  codigoGraph: number | null;
}

const invalidosPorTenant = new Map<string, TokenInvalido>();

function codigoGraphDe(detalle: string): number | null {
  try {
    const code = JSON.parse(detalle)?.error?.code;
    return typeof code === "number" ? code : null;
  } catch {
    return null; // no es JSON de Meta
  }
}

/** ¿Esta respuesta de Graph significa "el token de este negocio ya no sirve"? */
export function esErrorDeTokenInvalido(status: number, detalle: string): boolean {
  return status === 401 || codigoGraphDe(detalle) === CODIGO_GRAPH_TOKEN_INVALIDO;
}

/**
 * Registra el resultado de una llamada a Graph con el token del tenant. NUNCA
 * lanza: corre dentro del camino de envío y no puede cambiar su comportamiento.
 * `detalle` es el cuerpo de la respuesta (solo se lee si `ok` es false).
 */
export function registrarRespuestaGraph(tenantId: string, ok: boolean, status: number, detalle = ""): void {
  try {
    if (ok) {
      if (invalidosPorTenant.delete(tenantId)) {
        // Se recuperó: si vuelve a caerse, que avise de inmediato (sin esperar el cooldown).
        olvidarAlerta("token_whatsapp_invalido", tenantId);
      }
      return;
    }
    if (!esErrorDeTokenInvalido(status, detalle)) return;

    const ahora = new Date().toISOString();
    const previo = invalidosPorTenant.get(tenantId);
    const codigoGraph = codigoGraphDe(detalle);
    invalidosPorTenant.set(tenantId, { tenantId, desde: previo?.desde ?? ahora, ultimaFalla: ahora, status, codigoGraph });
    alertarPlataforma({
      tipo: "token_whatsapp_invalido",
      tenantId,
      severidad: "critica",
      mensaje:
        `Meta rechazó el access token de WhatsApp (HTTP ${status}${codigoGraph !== null ? `, código ${codigoGraph}` : ""}). ` +
        "El bot de este negocio no puede responder hasta que reconecte WhatsApp.",
      datos: { status, codigoGraph },
      cooldownMs: 6 * 60 * 60_000, // la condición no se arregla sola: recordar cada 6 h, no cada tick
    });
  } catch {
    // Observabilidad nunca rompe el envío.
  }
}

/** Tenants con el token marcado como inválido en ESTE proceso (para /salud y la vigilancia). */
export function listarTokensInvalidos(): TokenInvalido[] {
  return [...invalidosPorTenant.values()];
}

/** Solo para tests. */
export function _resetTokensInvalidosParaTests(): void {
  invalidosPorTenant.clear();
}
