import type { IncomingMessage, ServerResponse } from "node:http";

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades HTTP de bajo nivel del servidor.
//
// 1) Lectura del cuerpo con tope de tamaño.
//
// POR QUÉ: acumular el cuerpo entero en memoria antes de validarlo deja que un solo
// POST anónimo de cientos de MB tumbe el proceso por OOM (y con `ROLE=all` se caen web y
// workers de TODOS los negocios). Cada ruta lee con un tope acorde a lo que espera.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lee el cuerpo completo del request. Devuelve `null` en cuanto se pasa de `max` bytes
 * (sin seguir acumulando): el llamador responde 413. Corta antes con el
 * `content-length` declarado si ya excede el tope.
 */
export async function readBodyWithLimit(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > max) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > max) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

// 2) Red de seguridad del handler. `http.createServer(async ...)` NO atrapa los rechazos
// del callback: una excepción no prevista (p. ej. un header malformado) terminaba en un
// unhandledRejection — sin Sentry, Node mata el proceso y se cae el servicio de todos los
// negocios; con Sentry, el request quedaba colgado. Este wrapper la atrapa, la reporta y
// responde 500 si todavía se puede.
export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function withSafetyNet(
  handler: HttpHandler,
  report: (e: unknown) => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handler(req, res).catch((e) => {
      report(e);
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
