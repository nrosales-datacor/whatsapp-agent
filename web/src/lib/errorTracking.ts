import * as Sentry from "@sentry/react";
import type { Breadcrumb, ErrorEvent } from "@sentry/react";

// ─────────────────────────────────────────────────────────────────────────────
// Reporte de errores del panel a Sentry (mismo proyecto que el backend; se distingue por
// el tag `app: panel`). OPCIONAL: se activa solo si el server sirvió el index con
// `<meta name="sentry-dsn">` (src/platform/http/staticPanel.ts, sale de SENTRY_DSN del
// `.env` del servidor). Sin esa meta —desarrollo con Vite, modo mock, server sin DSN—
// todo es no-op y el panel funciona igual.
//
// Qué se reporta: los errores de render que atrapa `AppErrorBoundary` y, por los handlers
// globales del SDK, las excepciones y promesas rechazadas sin manejar (window.onerror /
// unhandledrejection).
//
// Datos personales (Ley 8968): `sendDefaultPii: false`, sin breadcrumbs de consola ni de
// clics (pueden traer nombres o textos de clientes) y las URLs (de la página y de las
// llamadas a la API) sin query ni fragmento: un enlace de invitación trae el token y una
// búsqueda de clientes trae nombres o teléfonos.
// ─────────────────────────────────────────────────────────────────────────────

let enabled = false;

function meta(name: string): string | undefined {
  const value = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content?.trim();
  return value || undefined;
}

/** URL sin query ni fragmento. */
export function stripQuery(url: string): string {
  const i = url.search(/[?#]/);
  return i === -1 ? url : url.slice(0, i);
}

const redactEmails = (text: string) => text.replace(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g, (m) => `${m[0]}***${m.slice(m.lastIndexOf("@"))}`);

function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === "console" || breadcrumb.category?.startsWith("ui.")) return null;
  if (breadcrumb.data) {
    const data = { ...breadcrumb.data };
    for (const key of ["url", "from", "to"]) {
      if (typeof data[key] === "string") data[key] = stripQuery(data[key] as string);
    }
    breadcrumb.data = data;
  }
  return breadcrumb;
}

/** Saca datos personales de un evento antes de mandarlo (el `beforeSend`). */
export function scrubPanelEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    const req = event.request;
    if (req.url) req.url = stripQuery(req.url);
    delete req.query_string;
    delete req.cookies;
    delete req.data;
    if (req.headers) req.headers = req.headers["User-Agent"] ? { "User-Agent": req.headers["User-Agent"] } : {};
  }
  delete event.user;
  if (event.message) event.message = redactEmails(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = redactEmails(ex.value);
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb).filter((b): b is Breadcrumb => b !== null);
  return event;
}

/** Arranca el reporte si el index trae el DSN. Se llama una vez, antes del primer render. */
export function initErrorTracking(): void {
  const dsn = meta("sentry-dsn");
  if (!dsn || enabled) return;
  try {
    Sentry.init({
      dsn,
      release: meta("sentry-release"),
      environment: meta("sentry-environment") ?? import.meta.env.MODE,
      sendDefaultPii: false,
      initialScope: { tags: { app: "panel" } },
      integrations: [Sentry.breadcrumbsIntegration({ console: false, dom: false })],
      beforeSend: (event) => scrubPanelEvent(event),
      beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    });
    enabled = true;
  } catch {
    // Un DSN mal formado no puede tumbar el panel: queda sin reporte.
  }
}

/** Reporta un error de render atrapado por un error boundary (con el stack de componentes). */
export function reportRenderError(error: unknown, componentStack: string | null | undefined): void {
  if (!enabled) return;
  Sentry.captureReactException(error, { componentStack: componentStack ?? "" }, { mechanism: { handled: true, type: "app_error_boundary" } });
}
