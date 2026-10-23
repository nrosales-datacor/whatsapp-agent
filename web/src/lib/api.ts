// ─────────────────────────────────────────────────────────────────────────────
// Cliente de la API del panel (/api/panel/*). Única puerta de salida del front hacia el
// backend:
//
//   • Sobre de respuesta: éxito `{ ok: true, data }` → devuelve `data`; error
//     `{ ok: false, error, code, fields? }` → lanza `ApiError` (status, code estable,
//     mensaje en español y errores por campo; ver ERROR_MESSAGES). 204 → `undefined`.
//   • Sucursal activa: viaja en el header `X-Location-Id` (la fija el proveedor de
//     sucursal con `setActiveLocationId`; sin sucursal = "todas").
//   • 401 `unauthorized` (sesión vencida o inexistente) → avisa al manejador registrado
//     con `onUnauthorized`, que limpia la sesión y la app cae al login. Un 401 con otro
//     código (p. ej. `invalid_credentials` del login) es un error normal del formulario.
//   • 403 `business_paused` (el superadmin pausó el negocio) → avisa a `onBusinessPaused`,
//     que vuelve a pedir la sesión y la app muestra "Cuenta pausada".
//   • Modo mock (`VITE_MOCK_API=1`): las respuestas salen de ./mockApi.ts con la misma
//     forma del contrato, sin red. En el build normal esa rama se elimina (la variable se
//     reemplaza en compilación) y el mock no viaja en el bundle.
// ─────────────────────────────────────────────────────────────────────────────

export const API_PREFIX = "/api/panel";
export const LOCATION_HEADER = "X-Location-Id";
export const IS_MOCK_API = import.meta.env.VITE_MOCK_API === "1";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const NETWORK_MESSAGE = "No pudimos conectar con el servidor. Revisá tu conexión y probá de nuevo.";
const GENERIC_MESSAGE = "Algo salió mal. Probá de nuevo en un momento.";

/**
 * Mensaje en español de cada código estable del backend. El backend ya manda su propio
 * `error` en español (más específico según el caso) y ese es el que se muestra; este
 * mapa es el respaldo cuando la respuesta no lo trae (proxy, 502, versión vieja) y la
 * referencia de los códigos que el panel conoce.
 */
export const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  // Genéricos (router / transporte)
  network_error: NETWORK_MESSAGE,
  server_error: GENERIC_MESSAGE,
  http_error: GENERIC_MESSAGE,
  invalid_response: GENERIC_MESSAGE,
  validation_error: "Datos inválidos: revisá los campos marcados.",
  unauthorized: "Tu sesión no es válida o venció. Iniciá sesión de nuevo.",
  forbidden: "No tenés permiso para hacer esto.",
  not_found: "No encontramos lo que buscabas.",
  too_many_attempts: "Demasiados intentos. Probá de nuevo en unos minutos.",
  module_not_in_plan: "Esta función no está incluida en tu plan.",
  // Planes y cobro (I2)
  plan_limit_reached: "Llegaste al tope de tu plan. Para sumar más, ampliá tu plan en Configuración › Plan.",
  business_paused: "La cuenta de este negocio está pausada. Escribinos para reactivarla.",
  already_paused: "El negocio ya estaba pausado.",
  already_active: "El negocio ya estaba activo.",
  business_closed: "El negocio está dado de baja.",
  // Identidad (I0.6)
  invalid_credentials: "Correo o clave incorrectos.",
  no_active_business: "Tu cuenta no tiene acceso a ningún negocio activo. Hablá con quien administra tu negocio.",
  business_forbidden: "No tenés acceso a ese negocio.",
  invalid_password: "La clave no es correcta.",
  invalid_code: "El código no es correcto.",
  totp_required: "Tu cuenta tiene verificación en dos pasos: escribí el código de tu app de autenticación.",
  totp_already_enabled: "La verificación en dos pasos ya está activa.",
  totp_not_enabled: "La verificación en dos pasos no está activa.",
  totp_not_setup: "Primero generá el código para tu app de autenticación.",
  invalid_token: "El enlace no es válido o venció. Pedí uno nuevo.",
  already_member: "Esa persona ya es parte del equipo.",
  last_owner: "Debe quedar al menos un dueño activo en el negocio.",
  user_inactive: "Esa cuenta está desactivada en la plataforma.",
  forbidden_role: "Tu rol no permite hacer este cambio.",
};

/** Mensaje en español para un código del backend (o el genérico si no se conoce). */
export function messageForCode(code: string): string {
  return ERROR_MESSAGES[code] ?? GENERIC_MESSAGE;
}

/** Error de la API con el código estable que manda el backend (`invalid_credentials`, …). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Errores por campo: la clave es la ruta del campo (`body.email`), el valor su mensaje. */
  readonly fields: Readonly<Record<string, string>>;
  readonly path: string;

  constructor(status: number, message: string, code: string, fields: Record<string, string>, path: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.path = path;
  }

  /** Mensaje de error de un campo del cuerpo (`fieldError("email")` lee `body.email`). */
  fieldError(name: string): string | undefined {
    return this.fields[`body.${name}`] ?? this.fields[name];
  }
}

export function isApiError(error: unknown, code?: string): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

/** Mensaje apto para mostrar de cualquier error (los de la API ya vienen en español). */
export function errorMessage(error: unknown, fallback = GENERIC_MESSAGE): string {
  if (error instanceof ApiError) return error.message || fallback;
  return fallback;
}

// ── Estado del cliente ──────────────────────────────────────────────────────

let activeLocationId: string | null = null;

/** Sucursal que viaja en `X-Location-Id` (null = todas / sin sucursal). */
export function setActiveLocationId(id: string | null): void {
  activeLocationId = id;
}

export function getActiveLocationId(): string | null {
  return activeLocationId;
}

type UnauthorizedHandler = (path: string) => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/** Registra quién reacciona a una sesión vencida (main.tsx). Devuelve cómo desregistrarlo. */
export function onUnauthorized(handler: UnauthorizedHandler): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

type BusinessPausedHandler = () => void;
let businessPausedHandler: BusinessPausedHandler | null = null;

/** Registra quién reacciona a un negocio pausado (main.tsx). Devuelve cómo desregistrarlo. */
export function onBusinessPaused(handler: BusinessPausedHandler): () => void {
  businessPausedHandler = handler;
  return () => {
    if (businessPausedHandler === handler) businessPausedHandler = null;
  };
}

// ── Transporte ──────────────────────────────────────────────────────────────

export interface TransportRequest {
  method: HttpMethod;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface TransportResponse {
  status: number;
  /** Cuerpo ya parseado (undefined si no había o no era JSON). */
  payload: unknown;
}

async function httpTransport(req: TransportRequest): Promise<TransportResponse> {
  const res = await fetch(API_PREFIX + req.path, {
    method: req.method,
    credentials: "same-origin",
    headers: req.headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
  });
  if (res.status === 204) return { status: 204, payload: undefined };
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    payload = undefined;
  }
  return { status: res.status, payload };
}

async function transport(req: TransportRequest): Promise<TransportResponse> {
  if (IS_MOCK_API) {
    const { mockTransport } = await import("./mockApi");
    return mockTransport(req);
  }
  return httpTransport(req);
}

interface ErrorEnvelope {
  ok: false;
  error?: string;
  code?: string;
  fields?: Record<string, string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Código por defecto cuando el backend no mandó uno (respuestas de proxy, 502, etc.). */
function fallbackCode(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "too_many_attempts";
  if (status >= 500) return "server_error";
  return "http_error";
}

export async function apiRequest<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (activeLocationId) headers[LOCATION_HEADER] = activeLocationId;

  let res: TransportResponse;
  try {
    res = await transport({ method, path, headers, body });
  } catch {
    throw new ApiError(0, NETWORK_MESSAGE, "network_error", {}, path);
  }

  if (res.status === 204) return undefined as T;
  const payload = res.payload;
  if (isObject(payload) && payload.ok === true && res.status < 400) return payload.data as T;

  let error: ApiError;
  if (isObject(payload) && payload.ok === false) {
    const env = payload as unknown as ErrorEnvelope;
    const code = env.code || fallbackCode(res.status);
    error = new ApiError(res.status, env.error || messageForCode(code), code, isObject(env.fields) ? env.fields : {}, path);
  } else {
    const code = res.status < 400 ? "invalid_response" : fallbackCode(res.status);
    error = new ApiError(res.status, messageForCode(code), code, {}, path);
  }

  if (error.status === 401 && error.code === "unauthorized") unauthorizedHandler?.(path);
  // `/auth/me` es quien muestra la pantalla: avisar desde ahí sería un bucle.
  if (error.code === "business_paused" && path !== "/auth/me") businessPausedHandler?.();
  throw error;
}

// ── Descargas (CSV de Reportes) ─────────────────────────────────────────────

/** Nombre del archivo de una cabecera `Content-Disposition: attachment; filename="…"`. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  const match = /filename="?([^";]+)"?/i.exec(header ?? "");
  return match?.[1]?.trim() || fallback;
}

/** Guarda un Blob como archivo (enlace temporal con `download`). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * GET de un archivo de la API (misma sesión y sucursal que el resto) y lo descarga. Un
 * error vuelve como `ApiError` con el mismo sobre que los JSON. En modo mock, el mock
 * responde `{ ok: true, data: { content, filename, contentType } }`.
 */
export async function apiDownload(path: string, fallbackName: string): Promise<string> {
  const headers: Record<string, string> = { Accept: "text/csv, application/json" };
  if (activeLocationId) headers[LOCATION_HEADER] = activeLocationId;
  if (IS_MOCK_API) {
    const data = await apiRequest<{ content: string; filename: string; contentType: string }>("GET", path);
    saveBlob(new Blob([data.content], { type: data.contentType }), data.filename || fallbackName);
    return data.filename || fallbackName;
  }
  let res: Response;
  try {
    res = await fetch(API_PREFIX + path, { method: "GET", credentials: "same-origin", headers });
  } catch {
    throw new ApiError(0, NETWORK_MESSAGE, "network_error", {}, path);
  }
  if (!res.ok) {
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = undefined;
    }
    const env = (isObject(payload) ? payload : {}) as Partial<ErrorEnvelope>;
    const code = env.code || fallbackCode(res.status);
    const error = new ApiError(res.status, env.error || messageForCode(code), code, isObject(env.fields) ? env.fields : {}, path);
    if (error.status === 401 && error.code === "unauthorized") unauthorizedHandler?.(path);
    if (error.code === "business_paused") businessPausedHandler?.();
    throw error;
  }
  const filename = filenameFromDisposition(res.headers.get("content-disposition"), fallbackName);
  saveBlob(await res.blob(), filename);
  return filename;
}

export const api = {
  get: <T>(path: string) => apiRequest<T>("GET", path),
  post: <T>(path: string, body?: unknown) => apiRequest<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => apiRequest<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>("PATCH", path, body),
  delete: <T>(path: string) => apiRequest<T>("DELETE", path),
};
