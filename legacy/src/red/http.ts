import type { IncomingMessage, ServerResponse } from "node:http";

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades HTTP del servidor (revisión pre-venta 2026-10).
//
// 1) Lectura del cuerpo con tope de tamaño.
//
// POR QUÉ: el webhook acumulaba el cuerpo entero en memoria ANTES de verificar la
// firma de Meta. Un solo POST anónimo de cientos de MB tumbaba el proceso por OOM
// (y con `ROL=todo` se caían webhook + panel + workers de TODOS los tenants). Los
// payloads reales de Meta pesan pocos KB (la media viaja aparte, por id), así que
// un tope de 1 MB sobra con margen.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_BODY_WEBHOOK = 1024 * 1024; // 1 MB

/**
 * Lee el cuerpo completo del request. Devuelve `null` en cuanto se pasa de
 * `max` bytes (sin seguir acumulando): el llamador responde 413. Corta antes
 * con el `content-length` declarado si ya excede el tope.
 */
export async function leerCuerpoConTope(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const declarado = Number(req.headers["content-length"]);
  if (Number.isFinite(declarado) && declarado > max) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > max) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

// 2) Red de seguridad del handler. `http.createServer(async ...)` NO atrapa los
// rechazos del callback: una excepción no prevista (p. ej. un header malformado)
// terminaba en un unhandledRejection — sin Sentry, Node mata el proceso y se cae
// el webhook de todos los tenants; con Sentry, el request quedaba colgado. Este
// wrapper la atrapa, la reporta y responde 500 si todavía se puede.
export type HandlerHttp = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function conRedDeSeguridad(
  handler: HandlerHttp,
  reportar: (e: unknown) => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handler(req, res).catch((e) => {
      reportar(e);
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end("Internal error");
        } else if (!res.writableEnded) {
          res.end();
        }
      } catch {
        // el socket ya no sirve: nada más que hacer
      }
    });
  };
}
