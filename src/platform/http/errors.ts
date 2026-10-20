// ─────────────────────────────────────────────────────────────────────────────
// Errores HTTP de la API del panel (/api/panel/*).
//
// Un handler (o un servicio que llama) lanza `HttpError` para cortar el request con un
// status y un mensaje PENSADO para el usuario (en español, sin detalles internos). El
// router (./router.ts) lo convierte en `{ ok: false, error, code? }`.
//
// Cualquier otra excepción es un bug o una falla de infraestructura: el router responde
// 500 con un mensaje genérico (nunca el `message` interno), la reporta a Sentry y la
// loguea.
// ─────────────────────────────────────────────────────────────────────────────

/** Error con status HTTP y mensaje apto para mostrar en el panel. */
export class HttpError extends Error {
  readonly status: number;
  /** Código estable para que el front decida qué hacer (p. ej. `module_not_in_plan`). */
  readonly code: string | undefined;
  /** Cabeceras extra de la respuesta (p. ej. `Allow` en un 405). */
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    status: number,
    message: string,
    code?: string,
    options: { headers?: Record<string, string>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.headers = options.headers ?? {};
  }
}

/**
 * 429 del rate limit de login (y de los demás intentos de credenciales). Mismo mensaje y
 * código sin importar qué límite se pasó (IP, par IP+usuario o global): quien mira la
 * respuesta no tiene que saber CUÁL disparó el corte. `Retry-After` en segundos.
 */
export function tooManyAttempts(retryAfterSec: number): HttpError {
  return new HttpError(429, "Demasiados intentos. Probá de nuevo en unos minutos.", "too_many_attempts", {
    headers: { "retry-after": String(Math.max(1, Math.ceil(retryAfterSec))) },
  });
}

/** Mensaje por defecto de un 400 por validación. */
export const VALIDATION_MESSAGE = "Datos inválidos: revisá los campos marcados.";

/**
 * 400 por datos inválidos, con el detalle por campo: `fields` mapea la ruta del campo
 * (`"body.name"`, `"query.page"`, `"params.id"`) a su primer mensaje de error.
 */
export class ValidationError extends HttpError {
  readonly fields: Readonly<Record<string, string>>;

  constructor(fields: Record<string, string>, message = VALIDATION_MESSAGE) {
    super(400, message, "validation_error");
    this.name = "ValidationError";
    this.fields = fields;
  }
}
