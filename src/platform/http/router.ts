import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import { readBodyWithLimit, type HttpHandler } from "../net/http";
import { log } from "../observability/log";
import { captureError } from "../observability/sentry";
import { HttpError, ValidationError } from "./errors";
import { isSameOrigin, MAX_JSON_BODY, sendJson } from "./http";
import type {
  AuthMode,
  ContextFor,
  HttpMethod,
  LocationMode,
  ModuleGate,
  PathSegment,
  RawQuery,
  Route,
  RouteContext,
  RouteLogger,
  RouteSpec,
  Session,
  SessionResolver,
  SuperadminResolver,
  SuperadminSession,
} from "./routeTypes";
import { validateInput, type InputSource } from "./validation";

// ─────────────────────────────────────────────────────────────────────────────
// Router declarativo de la API del panel (/api/panel/*), sin framework
// (PLAN-GESTION.md §2). Cada ruta DECLARA quién puede llamarla y qué recibe; el router
// aplica los chequeos antes del handler, siempre en este orden:
//
//   1. Ruta y método ............ 404 / 405 (con `Allow`)
//   2. CSRF de mismo origen ..... 403 `forbidden_origin` (POST/PUT/PATCH/DELETE)
//   3. Tope del cuerpo .......... 413 `payload_too_large`
//   4. Sesión ................... 401 `unauthorized` (negocio pausado: 403 `business_paused`,
//                                 salvo las rutas con `allowWhenPaused`)
//   5. Rol ...................... 403 `forbidden_role`
//   6. Módulo del plan .......... 403 `module_not_in_plan`
//   7. Sucursal (X-Location-Id) . 400 `location_required` / `location_invalid`,
//                                 403 `location_forbidden`
//   8. Validación (Zod) ......... 400 `invalid_json` / `validation_error` con `fields`
//
// Respuestas: éxito → `{ ok: true, data }` (200, o el status de `created()`/`reply()`);
// error → `{ ok: false, error, code?, fields? }`. Cualquier excepción que no sea
// `HttpError` → 500 genérico (sin el mensaje interno) + Sentry + log. Para fijar una
// cookie (login), el handler hace `ctx.res.setHeader("set-cookie", …)` y devuelve sus
// datos; si escribe la respuesta él mismo (descarga, stream), el router no la toca.
//
// Sesión, superadmin y planes son INYECTABLES (la identidad real vive en
// src/modules/team y src/admin, los planes en src/modules/billing, y los arma src/app.ts). Defaults
// seguros: sin resolver configurado toda ruta `user` o
// `superadmin` responde 401, y sin `moduleGate` toda ruta con `module` responde 403.
//
// Cómo registra rutas un módulo: exporta una función que devuelve su lista
// (`route(...)`), y src/routes.ts las junta en el único punto de composición.
// ─────────────────────────────────────────────────────────────────────────────

/** Prefijo de la API del panel (la costura estable con el front, ver CLAUDE.md). */
export const PANEL_API_PREFIX = "/api/panel";

const METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const AUTH_MODES: readonly AuthMode[] = ["user", "superadmin", "public"];
const STATE_CHANGING = new Set<string>(["POST", "PUT", "PATCH", "DELETE"]);
const LOCATION_HEADER = "x-location-id";
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_LITERAL = /^[A-Za-z0-9._~-]+$/;
const RE_PARAM = /^:([A-Za-z_][A-Za-z0-9_]*)$/;

const INTERNAL_ERROR_MESSAGE = "Error interno. Probá de nuevo en un momento.";

// ── Respuestas con otro status ──────────────────────────────────────────────

/** Resultado de un handler con status (y cabeceras) distintos del 200 por defecto. */
export class Reply<T> {
  readonly status: number;
  readonly data: T;
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, data: T, headers: Record<string, string> = {}) {
    this.status = status;
    this.data = data;
    this.headers = headers;
  }
}

/** Respuesta `{ ok: true, data }` con el status dado (204 y 304 salen sin cuerpo). */
export function reply<T>(status: number, data: T, headers?: Record<string, string>): Reply<T> {
  return new Reply(status, data, headers);
}

/** 201 Created con `{ ok: true, data }`. */
export function created<T>(data: T): Reply<T> {
  return new Reply(201, data);
}

/** 204 No Content, sin cuerpo. */
export function noContent(): Reply<null> {
  return new Reply(204, null);
}

// ── Declaración de rutas ────────────────────────────────────────────────────

/** Compila `"/a/:id"` a segmentos. Lanza si la ruta no tiene una forma válida. */
export function compilePath(path: string): PathSegment[] {
  if (path === "/") return [];
  if (!path.startsWith("/") || path.endsWith("/")) {
    throw new Error(`route: ruta inválida "${path}" (debe empezar con "/" y no terminar en "/")`);
  }
  const names = new Set<string>();
  return path
    .slice(1)
    .split("/")
    .map((segment): PathSegment => {
      const param = RE_PARAM.exec(segment);
      if (param) {
        const name = param[1];
        if (names.has(name)) throw new Error(`route: parámetro ":${name}" repetido en "${path}"`);
        names.add(name);
        return { kind: "param", name };
      }
      if (!RE_LITERAL.test(segment)) throw new Error(`route: segmento inválido "${segment}" en "${path}"`);
      return { kind: "literal", value: segment };
    });
}

/**
 * Declara una ruta de la API. Los tipos de `ctx.params`, `ctx.query` y `ctx.body` salen
 * de los esquemas Zod (o, sin esquema, de la ruta / query cruda / `undefined`);
 * `ctx.session` y `ctx.locationId` salen de `auth` y `location`.
 *
 * ```ts
 * route(
 *   { method: "POST", path: "/appointments/:id/payments", auth: "user",
 *     roles: ["owner", "admin", "front_desk"], module: "sales", location: "required",
 *     params: z.object({ id: z.uuid() }), body: PaymentInput },
 *   async ({ params, body, session, locationId }) => created(await recordPayment(...)),
 * )
 * ```
 *
 * Lanza al declarar (es decir, al arrancar) si la declaración es incoherente.
 */
export function route<
  M extends HttpMethod,
  P extends string,
  A extends AuthMode,
  L extends LocationMode | undefined = undefined,
  PS extends z.ZodType | undefined = undefined,
  QS extends z.ZodType | undefined = undefined,
  BS extends z.ZodType | undefined = undefined,
>(spec: RouteSpec<M, P, A, L, PS, QS, BS>, handler: (ctx: ContextFor<P, A, L, PS, QS, BS>) => unknown): Route {
  const { method, path, auth, roles, module, location, allowWhenPaused, params, query, body, maxBodyBytes } = spec;
  const where = `${String(method)} ${String(path)}`;

  if (!METHODS.includes(method)) throw new Error(`route ${where}: método no soportado`);
  if (!AUTH_MODES.includes(auth)) throw new Error(`route ${where}: auth inválido "${String(auth)}"`);
  const segments = compilePath(path);
  if (auth !== "user" && (roles !== undefined || module !== undefined || location !== undefined || allowWhenPaused !== undefined)) {
    throw new Error(`route ${where}: roles, module, location y allowWhenPaused solo aplican a auth "user"`);
  }
  if (roles !== undefined && roles.length === 0) {
    throw new Error(`route ${where}: roles vacío dejaría la ruta sin acceso (omitilo para permitir todos los roles)`);
  }
  if (module !== undefined && module.trim() === "") throw new Error(`route ${where}: module vacío`);
  if (location !== undefined && location !== "required" && location !== "optional") {
    throw new Error(`route ${where}: location inválido "${String(location)}"`);
  }
  if (method === "GET" && (body !== undefined || maxBodyBytes !== undefined)) {
    throw new Error(`route ${where}: un GET no lleva cuerpo`);
  }
  if (maxBodyBytes !== undefined && !(Number.isInteger(maxBodyBytes) && maxBodyBytes > 0)) {
    throw new Error(`route ${where}: maxBodyBytes debe ser un entero positivo`);
  }

  return Object.freeze({
    method,
    path,
    auth,
    roles: roles === undefined ? undefined : Object.freeze([...roles]),
    module,
    location,
    allowWhenPaused: allowWhenPaused === true ? true : undefined,
    params,
    query,
    body,
    maxBodyBytes,
    segments: Object.freeze(segments),
    handle: handler as unknown as Route["handle"],
  });
}

// ── Registro y despacho ─────────────────────────────────────────────────────

export interface RouterOptions {
  /** Todas las rutas de la API (ver src/routes.ts). */
  routes: readonly Route[];
  /** Prefijo que se le quita a la URL antes de buscar la ruta. Default `/api/panel`. */
  prefix?: string;
  /** Sesión del equipo. Sin él, toda ruta `auth: "user"` responde 401. */
  resolveSession?: SessionResolver;
  /** Sesión del superadmin. Sin él, toda ruta `auth: "superadmin"` responde 401. */
  resolveSuperadmin?: SuperadminResolver;
  /** Módulos del plan. Sin él, toda ruta con `module` responde 403. */
  moduleGate?: ModuleGate;
  /** Tope del cuerpo por defecto, en bytes (default `MAX_JSON_BODY`, 64 KB). */
  maxBodyBytes?: number;
  /** Reporte de errores no previstos (default: Sentry). */
  reportError?: (error: unknown, context: Record<string, unknown>) => void;
}

type Match =
  | { kind: "found"; route: Route; params: Record<string, string> }
  | { kind: "method_not_allowed"; allow: HttpMethod[] }
  | { kind: "not_found" };

/** Clave de forma de una ruta: dos rutas con la misma clave y método chocan. */
function shapeKey(r: Route): string {
  return r.segments.map((s) => (s.kind === "literal" ? s.value : ":")).join("/");
}

/** Especificidad: un literal gana a un parámetro en la primera posición en que difieren. */
function specificity(r: Route): string {
  return r.segments.map((s) => (s.kind === "literal" ? "1" : "0")).join("");
}

/** Partes de la ruta relativas al prefijo, o null si la URL no está bajo el prefijo. */
function relativeParts(pathname: string, prefix: string): string[] | null {
  let rest: string;
  if (pathname === prefix) rest = "/";
  else if (pathname.startsWith(`${prefix}/`)) rest = pathname.slice(prefix.length);
  else return null;
  if (rest.length > 1 && rest.endsWith("/")) rest = rest.slice(0, -1); // `/ping/` = `/ping`
  return rest === "/" ? [] : rest.slice(1).split("/");
}

function matchSegments(segments: readonly PathSegment[], parts: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const part = parts[i];
    if (segment.kind === "literal") {
      if (part !== segment.value) return null;
      continue;
    }
    if (!part) return null;
    try {
      params[segment.name] = decodeURIComponent(part);
    } catch {
      return null; // escape inválido (`%zz`): no calza con ninguna ruta
    }
  }
  return params;
}

/** Query → objeto (clave repetida → lista). Propiedades propias: `__proto__` no toca el prototipo. */
function queryObject(searchParams: URLSearchParams): RawQuery {
  const out: RawQuery = {};
  for (const [key, value] of searchParams) {
    const prev = Object.prototype.hasOwnProperty.call(out, key) ? out[key] : undefined;
    const next = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
    Object.defineProperty(out, key, { value: next, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function boundLogger(base: Record<string, unknown>): RouteLogger {
  return {
    info: (event, fields = {}) => log.info(event, { ...base, ...fields }),
    warn: (event, fields = {}) => log.warn(event, { ...base, ...fields }),
    error: (event, fields = {}) => log.error(event, { ...base, ...fields }),
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const unauthorized = () =>
  new HttpError(401, "Tu sesión no es válida o venció. Iniciá sesión de nuevo.", "unauthorized");

/** Sucursal del request según el modo de la ruta y el acceso de la sesión. */
function resolveLocation(mode: LocationMode | undefined, req: IncomingMessage, session: Session): string | null {
  if (mode === undefined) return null;
  const raw = req.headers[LOCATION_HEADER];
  if (Array.isArray(raw)) throw new HttpError(400, "La sucursal indicada no es válida.", "location_invalid");
  const value = raw?.trim();
  if (!value) {
    if (mode === "required") throw new HttpError(400, "Falta indicar la sucursal.", "location_required");
    return null;
  }
  if (!RE_UUID.test(value)) throw new HttpError(400, "La sucursal indicada no es válida.", "location_invalid");
  const id = value.toLowerCase();
  const { locationIds } = session;
  const allowed = locationIds === "all" || locationIds.some((l) => l.toLowerCase() === id);
  if (!allowed) throw new HttpError(403, "No tenés acceso a esta sucursal.", "location_forbidden");
  return id;
}

function sendResult(res: ServerResponse, result: unknown): void {
  if (result instanceof Reply) {
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    if (result.status === 204 || result.status === 304) {
      res.writeHead(result.status);
      res.end();
      return;
    }
    sendJson(res, result.status, { ok: true, data: result.data ?? null });
    return;
  }
  sendJson(res, 200, { ok: true, data: result ?? null });
}

/**
 * Crea el handler de la API (`/api/panel/*`). Valida el conjunto de rutas al crearse
 * (rutas duplicadas → lanza) para que un error de declaración rompa el arranque y no un
 * request en producción.
 */
export function createRouter(options: RouterOptions): HttpHandler {
  const {
    routes,
    prefix = PANEL_API_PREFIX,
    resolveSession,
    resolveSuperadmin,
    moduleGate,
    maxBodyBytes = MAX_JSON_BODY,
    reportError = captureError,
  } = options;

  if (prefix !== "" && (!prefix.startsWith("/") || prefix.endsWith("/"))) {
    throw new Error(`createRouter: prefijo inválido "${prefix}"`);
  }

  const seen = new Map<string, Route>();
  const rank = new Map<Route, string>();
  for (const r of routes) {
    const key = `${r.method} ${shapeKey(r)}`;
    const other = seen.get(key);
    if (other) throw new Error(`createRouter: ruta duplicada ${r.method} ${r.path} (choca con ${other.path})`);
    seen.set(key, r);
    rank.set(r, specificity(r));
  }

  // Configuración incompleta: se avisa una vez al arrancar (los requests igual se niegan).
  if (!resolveSession && routes.some((r) => r.auth === "user")) {
    log.warn("router_session_resolver_missing", { detail: "las rutas auth=user van a responder 401" });
  }
  if (!resolveSuperadmin && routes.some((r) => r.auth === "superadmin")) {
    log.warn("router_superadmin_resolver_missing", { detail: "las rutas auth=superadmin van a responder 401" });
  }
  if (!moduleGate && routes.some((r) => r.module !== undefined)) {
    log.warn("router_module_gate_missing", { detail: "las rutas con module van a responder 403" });
  }

  function findRoute(method: string, parts: string[]): Match {
    let best: { route: Route; params: Record<string, string>; rank: string } | null = null;
    const allow = new Set<HttpMethod>();
    for (const r of routes) {
      if (r.segments.length !== parts.length) continue;
      const params = matchSegments(r.segments, parts);
      if (!params) continue;
      allow.add(r.method);
      if (r.method !== method) continue;
      const routeRank = rank.get(r) ?? "";
      if (!best || routeRank > best.rank) best = { route: r, params, rank: routeRank };
    }
    if (best) return { kind: "found", route: best.route, params: best.params };
    if (allow.size > 0) return { kind: "method_not_allowed", allow: METHODS.filter((m) => allow.has(m)) };
    return { kind: "not_found" };
  }

  async function validated(
    schema: z.ZodType | undefined,
    input: unknown,
    source: InputSource,
    fields: Record<string, string>,
  ): Promise<unknown> {
    if (!schema) return input;
    const result = await validateInput(schema, input, source);
    if (result.ok) return result.data;
    Object.assign(fields, result.fields);
    return undefined;
  }

  async function dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    url: URL,
    match: Extract<Match, { kind: "found" }>,
    logFields: Record<string, unknown>,
    reqLog: RouteLogger,
    requestId: string,
  ): Promise<void> {
    const r = match.route;

    // 2) CSRF: todo método que cambia estado exige Origin/Referer del mismo host.
    if (STATE_CHANGING.has(method) && !isSameOrigin(req)) {
      throw new HttpError(403, "Origen de la solicitud no permitido.", "forbidden_origin");
    }

    // 3) Cuerpo con tope. Se lee siempre (fuera de GET) para que el tope aplique aunque la
    // ruta no declare esquema; el JSON solo se interpreta si hay esquema, y si es inválido
    // se responde en la etapa de validación (después de sesión y permisos).
    let rawBody: unknown = undefined;
    let invalidJson = false;
    if (method !== "GET") {
      const buffer = await readBodyWithLimit(req, r.maxBodyBytes ?? maxBodyBytes);
      if (buffer === null) {
        throw new HttpError(413, "El cuerpo de la solicitud es demasiado grande.", "payload_too_large", {
          headers: { connection: "close" },
        });
      }
      if (r.body) {
        if (buffer.length === 0) rawBody = {};
        else {
          try {
            rawBody = JSON.parse(buffer.toString("utf8"));
          } catch {
            invalidJson = true;
          }
        }
      }
    }

    // 4–7) Sesión, rol, módulo y sucursal.
    let session: Session | SuperadminSession | null = null;
    let locationId: string | null = null;
    if (r.auth === "user") {
      const userSession = resolveSession ? await resolveSession(req, r.allowWhenPaused ? { allowPaused: true } : undefined) : null;
      if (!userSession) throw unauthorized();
      session = userSession;
      logFields.businessId = userSession.businessId;
      logFields.userId = userSession.userId;

      if (r.roles && !r.roles.includes(userSession.role)) {
        throw new HttpError(403, "No tenés permiso para esta acción.", "forbidden_role");
      }
      if (r.module !== undefined) {
        const enabled = moduleGate ? await moduleGate(userSession.businessId, r.module) : false;
        if (enabled !== true) {
          throw new HttpError(403, "Esta función no está incluida en el plan del negocio.", "module_not_in_plan");
        }
      }
      locationId = resolveLocation(r.location, req, userSession);
    } else if (r.auth === "superadmin") {
      const adminSession = resolveSuperadmin ? await resolveSuperadmin(req) : null;
      if (!adminSession) throw unauthorized();
      session = adminSession;
      logFields.adminId = adminSession.adminId;
    }

    // 8) Validación: se juntan los errores de params, query y cuerpo en una sola respuesta.
    if (invalidJson) throw new HttpError(400, "El cuerpo de la solicitud no es JSON válido.", "invalid_json");
    const fields: Record<string, string> = {};
    const params = await validated(r.params, match.params, "params", fields);
    const query = await validated(r.query, queryObject(url.searchParams), "query", fields);
    const body = await validated(r.body, rawBody, "body", fields);
    if (Object.keys(fields).length > 0) throw new ValidationError(fields);

    const ctx: RouteContext = { req, res, params, query, body, session, locationId, log: reqLog, requestId };
    const result = await r.handle(ctx);

    // El handler puede responder por su cuenta (descarga, stream): se respeta.
    if (res.headersSent || res.writableEnded) return;
    sendResult(res, result);
  }

  function sendFailure(
    res: ServerResponse,
    error: unknown,
    reqLog: RouteLogger,
    logFields: Record<string, unknown>,
  ): void {
    let status: number;
    let payload: Record<string, unknown>;
    let headers: Readonly<Record<string, string>> = {};

    if (error instanceof HttpError) {
      status = error.status;
      payload = { ok: false, error: error.message };
      if (error.code) payload.code = error.code;
      if (error instanceof ValidationError) payload.fields = error.fields;
      headers = error.headers;
      if (status >= 500) {
        reqLog.error("http_route_error", { status, code: error.code, error: error.message });
        reportError(error, { ...logFields });
      }
    } else {
      // Bug o falla de infraestructura: el detalle va al log y a Sentry, NUNCA al cliente.
      reqLog.error("http_route_unhandled_error", { error: errorMessage(error) });
      reportError(error, { ...logFields });
      status = 500;
      payload = { ok: false, error: INTERNAL_ERROR_MESSAGE, code: "internal_error" };
    }

    if (res.headersSent) {
      // El handler ya empezó a responder: no se puede cambiar el status, solo cerrar.
      if (!res.writableEnded) res.end();
      return;
    }
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    sendJson(res, status, payload);
  }

  return async function panelApi(req, res) {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);
    res.setHeader("cache-control", "no-store");
    const method = (req.method ?? "GET").toUpperCase();
    const logFields: Record<string, unknown> = { requestId, method };
    const reqLog = boundLogger(logFields);

    try {
      // Base fija (no el header Host): un Host malformado no puede tumbar el request.
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = relativeParts(url.pathname, prefix);
      const match: Match = parts === null ? { kind: "not_found" } : findRoute(method, parts);

      // 1) Ruta y método.
      if (match.kind === "not_found") throw new HttpError(404, "Recurso no encontrado.", "not_found");
      if (match.kind === "method_not_allowed") {
        throw new HttpError(405, "Método no permitido.", "method_not_allowed", {
          headers: { allow: match.allow.join(", ") },
        });
      }
      logFields.route = `${match.route.method} ${match.route.path}`;
      await dispatch(req, res, method, url, match, logFields, reqLog, requestId);
    } catch (error) {
      sendFailure(res, error, reqLog, logFields);
    }
  };
}
