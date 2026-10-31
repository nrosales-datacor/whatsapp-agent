import * as Sentry from "@sentry/node";
import type { Breadcrumb, ErrorEvent } from "@sentry/node";
import { redactEmails, sanitizeLogFields } from "./privacy";

// ─────────────────────────────────────────────────────────────────────────────
// Captura de errores. OPCIONAL: sin SENTRY_DSN todo es no-op — el producto funciona
// igual, solo sin reportes (en producción el arranque lo advierte fuerte, ver
// productionConfigWarnings y server.ts).
//
// Sentry.init() ya registra por defecto los handlers globales de:
//   • uncaughtException → captura y sale del proceso (PM2 reinicia igual).
//   • unhandledRejection → captura y SOLO avisa, no mata el proceso. Sin Sentry, un
//     rechazo sin manejar tumba TODO el proceso para todos los negocios (comportamiento
//     default de Node desde v15). Con Sentry activo queda reportado y el servidor sigue
//     en pie — mejora de fiabilidad de regalo, no solo alertas.
//
// Además de esos globales, `captureError` se llama a mano en los catch que ya atrapan el
// error (reintentos, loops) pero que, sin esto, solo lo mandarían a `console.error` sin
// que nadie se entere.
//
// Un solo proyecto de Sentry para backend y panel (decisión del usuario, plan gratis): se
// distinguen por el tag `app` ("backend" / "panel"), y cada evento lleva `environment`
// (NODE_ENV) y `release` (SENTRY_RELEASE = SHA del commit, lo fija el deploy).
//
// Datos personales (Ley 8968, ver ./privacy.ts): `sendDefaultPii: false` (sin IP, sin
// cookies) y `beforeSend` (`scrubEvent`) pasa `extra`/`contexts`/breadcrumbs por
// `sanitizeLogFields`, saca del request el cuerpo, las cookies, la query y las cabeceras
// que no estén en una lista corta, y enmascara correos en los mensajes de error. El cuerpo
// de los requests ni se lee (`maxIncomingRequestBodySize: "none"`): un webhook de
// WhatsApp trae teléfonos y textos de clientes, un login trae la clave.
// ─────────────────────────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;

const DSN = process.env.SENTRY_DSN;

/**
 * Versión que corre: el SHA del commit que fija el deploy (`SENTRY_RELEASE`, ver
 * .github/workflows/ci-cd.yml). Sin ella, Sentry agrupa los eventos sin versión. La
 * reutiliza el log estructurado.
 */
export function currentRelease(env: Env = process.env): string | undefined {
  return env.SENTRY_RELEASE?.trim() || undefined;
}

/** `transport`: solo para tests (un transporte en memoria en vez de la red). */
export function initSentry(options: { transport?: Sentry.NodeOptions["transport"] } = {}): void {
  if (!DSN) return;
  Sentry.init({
    ...(options.transport ? { transport: options.transport } : {}),
    dsn: DSN,
    environment: process.env.NODE_ENV ?? "development",
    release: currentRelease(),
    sendDefaultPii: false, // explícito: sin IP ni cookies aunque cambie el default del SDK
    tracesSampleRate: 0, // solo errores, sin tracing de performance
    initialScope: { tags: { app: "backend", role: process.env.ROLE?.trim() || "all" } },
    // Mismo nombre que las integraciones por defecto: las reemplazan con estas opciones.
    integrations: [
      Sentry.httpIntegration({ maxIncomingRequestBodySize: "none" }),
      Sentry.requestDataIntegration({ include: { cookies: false, data: false, ip: false, query_string: false } }),
    ],
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  });
}

export function isSentryConfigured(): boolean {
  return Boolean(DSN);
}

/** Reporta a Sentry un error ya atrapado que vale la pena alertar. No-op sin DSN. */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (!DSN) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}

/**
 * Espera a que Sentry mande los eventos pendientes. Solo hace falta en scripts de vida
 * corta (p. ej. `scripts/backupDb.ts`), que terminan antes del envío async. true si se
 * vació la cola a tiempo (false sin DSN o si se venció el plazo).
 */
export async function flushSentry(ms = 5000): Promise<boolean> {
  if (!DSN) return false;
  return Sentry.flush(ms).catch(() => false);
}

// ── Saneo de eventos (beforeSend) ────────────────────────────────────────────

/** Cabeceras del request que sí viajan a Sentry (el resto puede traer sesión, firmas o tokens). */
const SAFE_HEADERS = new Set(["user-agent", "content-type", "content-length", "accept", "accept-language", "x-forwarded-proto"]);

/** Saca la query y el fragmento de una URL (un enlace de invitación o de recuperación trae el token ahí). */
export function stripQuery(url: string): string {
  const i = url.search(/[?#]/);
  return i === -1 ? url : url.slice(0, i);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Breadcrumb saneado: los mismos campos que el log (./privacy.ts) y la URL sin query. */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (breadcrumb.message) breadcrumb.message = redactEmails(breadcrumb.message);
  if (isRecord(breadcrumb.data)) {
    const data = { ...sanitizeLogFields(breadcrumb.data) };
    if (typeof data.url === "string") data.url = stripQuery(data.url);
    breadcrumb.data = data;
  }
  return breadcrumb;
}

/**
 * Saca los datos personales de un evento antes de mandarlo (el `beforeSend` de
 * `initSentry`). Muta y devuelve el mismo evento. Exportado para el test.
 */
export function scrubEvent<E extends ErrorEvent>(event: E): E {
  if (event.extra) event.extra = sanitizeLogFields(event.extra);
  if (event.contexts) {
    for (const [key, value] of Object.entries(event.contexts)) {
      if (isRecord(value)) event.contexts[key] = sanitizeLogFields(value);
    }
  }
  if (event.request) {
    const req = event.request;
    delete req.data;
    delete req.cookies;
    delete req.query_string;
    if (req.url) req.url = stripQuery(req.url);
    if (req.headers) {
      req.headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => SAFE_HEADERS.has(name.toLowerCase())));
    }
  }
  // El backend no identifica personas en Sentry: ni IP, ni correo, ni usuario.
  delete event.user;
  if (event.message) event.message = redactEmails(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = redactEmails(ex.value);
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  return event;
}

// ── Panel (navegador) ────────────────────────────────────────────────────────

export interface PanelSentryConfig {
  dsn: string;
  /** Origen del DSN (`https://oNNN.ingest.sentry.io`): lo suma la CSP del panel a `connect-src`. */
  origin: string;
  release: string | undefined;
  environment: string;
}

/**
 * Configuración de Sentry para el panel, o null sin DSN. El server la agrega como
 * `<meta name="sentry-*">` al servir el index del panel (staticPanel.ts) y la CSP del panel
 * suma su origen a `connect-src` (securityHeaders.ts): el panel se activa con el mismo
 * `.env` del servidor, sin recompilarlo. `SENTRY_PANEL_DSN` (opcional) es otra clave del
 * MISMO proyecto, para poder limitarla o revocarla sin tocar la del backend: el DSN del
 * navegador es público por diseño (cualquiera lo ve en el HTML).
 */
export function panelSentryConfig(env: Env = process.env): PanelSentryConfig | null {
  const dsn = env.SENTRY_PANEL_DSN?.trim() || env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return { dsn, origin: url.origin, release: currentRelease(env), environment: env.NODE_ENV ?? "development" };
}
