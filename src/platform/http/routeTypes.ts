import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import type { Role } from "../auth/sessionToken";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos del router declarativo de la API del panel (ver ./router.ts y
// PLAN-GESTION.md §2). Acá vive el contrato que usan los módulos para declarar rutas;
// la mecánica (matching, chequeos, respuestas) está en router.ts.
// ─────────────────────────────────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Quién puede llamar la ruta:
 *   • "user": miembro del equipo de un negocio (sesión del panel).
 *   • "superadmin": la plataforma (sesión aparte, sin negocio).
 *   • "public": sin sesión (login, ping, recuperación de clave…).
 */
export type AuthMode = "user" | "superadmin" | "public";

/** Si la ruta exige la sucursal del request (header `X-Location-Id`) o la acepta opcional. */
export type LocationMode = "required" | "optional";

/**
 * Sesión de un miembro del equipo, tal como la entrega el `SessionResolver` (el real es
 * `createSessionResolver` de src/modules/team, validado contra la base en cada request);
 * el router solo consume esta forma. Rol y sucursales salen de la membresía viva.
 */
export interface Session {
  userId: string;
  businessId: string;
  role: Role;
  /** Sucursales a las que tiene acceso: lista de ids (uuid) o "all" (todas las del negocio). */
  locationIds: readonly string[] | "all";
  /** Epoch de la cuenta con el que se firmó la sesión (revocación sin estado). */
  sessionEpoch: number;
}

/** Sesión del superadmin (la plataforma, src/admin/session.ts). */
export interface SuperadminSession {
  /** Usuario del superadmin (PANEL_SUPERADMIN_USERNAME): va al actor del rastro de auditoría. */
  adminId: string;
}

/** Resuelve la sesión del equipo desde el request (cookie). `null` = sin sesión válida → 401. */
export type SessionResolver = (req: IncomingMessage) => Promise<Session | null>;

/** Resuelve la sesión del superadmin desde el request. `null` = sin sesión válida → 401. */
export type SuperadminResolver = (req: IncomingMessage) => Promise<SuperadminSession | null>;

/** ¿El plan del negocio incluye este módulo? Los planes llegan en I2. */
export type ModuleGate = (businessId: string, module: string) => boolean | Promise<boolean>;

type LogFields = Record<string, unknown>;

/** Logger del request: cada evento sale con `requestId`, ruta y (si hay sesión) negocio/usuario. */
export interface RouteLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/** Nombres de los parámetros de una ruta: `"/a/:id/b/:x"` → `"id" | "x"`. */
export type PathParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;

/** Parámetros de la ruta sin esquema: todos `string` (ya decodificados). */
export type PathParams<P extends string> = { [K in PathParamNames<P>]: string };

/** Query sin esquema: un valor por clave, o una lista si la clave se repite. */
export type RawQuery = Record<string, string | string[]>;

export type SessionFor<A extends AuthMode> = A extends "user"
  ? Session
  : A extends "superadmin"
    ? SuperadminSession
    : null;

export type LocationFor<L extends LocationMode | undefined> = L extends "required"
  ? string
  : L extends "optional"
    ? string | null
    : null;

/** Tipo de salida de un esquema Zod opcional, o `Fallback` si la ruta no declara esquema. */
export type SchemaOutput<S, Fallback> = S extends z.ZodType ? z.output<S> : Fallback;

/** Lo que recibe el handler de una ruta, tipado según su declaración. */
export interface RouteContext<
  A extends AuthMode = AuthMode,
  L extends LocationMode | undefined = LocationMode | undefined,
  Params = unknown,
  Query = unknown,
  Body = unknown,
> {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly params: Params;
  readonly query: Query;
  readonly body: Body;
  readonly session: SessionFor<A>;
  /** Sucursal del request (uuid en minúsculas), ya validada contra el acceso del usuario. */
  readonly locationId: LocationFor<L>;
  readonly log: RouteLogger;
  /** Id del request (también va en la cabecera `x-request-id` de la respuesta). */
  readonly requestId: string;
}

/** Declaración de una ruta (sin el handler). */
export interface RouteSpecBase<
  M extends HttpMethod,
  P extends string,
  A extends AuthMode,
  L extends LocationMode | undefined,
  PS extends z.ZodType | undefined,
  QS extends z.ZodType | undefined,
  BS extends z.ZodType | undefined,
> {
  method: M;
  /** Ruta relativa al prefijo de la API (`/api/panel`), p. ej. `"/appointments/:id/payments"`. */
  path: P;
  auth: A;
  /** Roles permitidos (solo `auth: "user"`). Sin `roles`, cualquier rol del negocio. */
  roles?: readonly Role[];
  /** Módulo del plan que habilita la ruta (solo `auth: "user"`). */
  module?: string;
  /** Sucursal del request (solo `auth: "user"`). Sin `location`, el header se ignora. */
  location?: L;
  params?: PS;
  query?: QS;
  body?: BS;
  /** Tope del cuerpo en bytes (default: `MAX_JSON_BODY`, 64 KB). */
  maxBodyBytes?: number;
}

/** Lo que no aplica a rutas sin negocio (superadmin y públicas). */
type BusinessOnlyFields = { roles?: never; module?: never; location?: never };

/**
 * Declaración completa: lo de `RouteSpecBase` más las restricciones de tipo (roles, módulo
 * y sucursal solo con `auth: "user"`; un GET no lleva cuerpo). El router repite estos
 * chequeos en runtime al registrar la ruta.
 */
export type RouteSpec<
  M extends HttpMethod,
  P extends string,
  A extends AuthMode,
  L extends LocationMode | undefined,
  PS extends z.ZodType | undefined,
  QS extends z.ZodType | undefined,
  BS extends z.ZodType | undefined,
> = RouteSpecBase<M, P, A, L, PS, QS, BS> &
  (A extends "user" ? unknown : BusinessOnlyFields) &
  (M extends "GET" ? { body?: never; maxBodyBytes?: never } : unknown);

/** Contexto que recibe el handler de una ruta declarada con `RouteSpec<…>`. */
export type ContextFor<
  P extends string,
  A extends AuthMode,
  L extends LocationMode | undefined,
  PS extends z.ZodType | undefined,
  QS extends z.ZodType | undefined,
  BS extends z.ZodType | undefined,
> = RouteContext<
  A,
  L,
  SchemaOutput<PS, PathParams<P>>,
  SchemaOutput<QS, RawQuery>,
  SchemaOutput<BS, undefined>
>;

/** Segmento compilado de una ruta: literal o parámetro. */
export type PathSegment = { kind: "literal"; value: string } | { kind: "param"; name: string };

/**
 * Ruta ya registrable (sin tipos genéricos): lo que devuelve `route()` y lo que cada
 * módulo exporta en su lista de rutas.
 */
export interface Route {
  readonly method: HttpMethod;
  readonly path: string;
  readonly auth: AuthMode;
  readonly roles?: readonly Role[];
  readonly module?: string;
  readonly location?: LocationMode;
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  readonly maxBodyBytes?: number;
  /** Ruta compilada (uso interno del router). */
  readonly segments: readonly PathSegment[];
  /** Handler con el contexto ya validado (uso interno del router). */
  handle(ctx: RouteContext): unknown;
}
