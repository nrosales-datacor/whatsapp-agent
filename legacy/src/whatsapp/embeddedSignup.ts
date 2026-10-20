import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Embedded Signup de Meta (ROADMAP C4.2). Deja que un negocio conecte su WhatsApp
// Business desde nuestro onboarding con el popup de Facebook, en vez de que alguien
// copie a mano el phone_number_id y el token desde Meta.
//
// El flujo:
//   1) El frontend abre el popup (FB Login for Business) con nuestra config de ES.
//      Meta devuelve un `code` de autorización + el phone_number_id y el waba_id que
//      el negocio eligió (por el evento `message` del SDK).
//   2) Acá cambiamos ese `code` por un ACCESS TOKEN del WABA del cliente
//      (intercambiarCodigo), suscribimos nuestra app a los webhooks de ese WABA
//      (suscribirApp) y registramos el número en la Cloud API (registrarNumero).
//   3) Guardamos el token en un stash efímero (guardarTokenTemporal) y devolvemos un
//      `handle` al frontend. Al confirmar el alta, el router canjea el handle por el
//      token y lo persiste en wa_tenants con crearTenant (B2/B3) — SIN redeploy.
//
// Igual que Sentry/Calendar/Push: sin la config de env es un NO-OP total. El
// onboarding manual (/panel/admin) sigue siendo el camino mientras no esté aprobado
// el trámite Tech Provider + App Review de Meta (ver GUIA-META.md §B).
// ─────────────────────────────────────────────────────────────────────────────

const GRAPH_VERSION = process.env.GRAPH_API_VERSION ?? "v21.0";

/** App de Meta (developers.facebook.com). El id es público; el secret es el mismo del webhook. */
function appId(): string | undefined {
  return process.env.META_APP_ID?.trim() || undefined;
}
function appSecret(): string | undefined {
  return process.env.WHATSAPP_APP_SECRET?.trim() || undefined;
}
/** Id de la "configuración de Embedded Signup" creada en el panel de la app de Meta. */
function configId(): string | undefined {
  return process.env.META_ES_CONFIG_ID?.trim() || undefined;
}

/** true si están las tres piezas para ofrecer el flujo (app id + config + secret). */
export function embeddedSignupConfigurado(): boolean {
  return !!(appId() && configId() && appSecret());
}

/** Config PÚBLICA para el frontend (nunca el secret). null si no está configurado. */
export function configPublica(): { appId: string; configId: string; graphVersion: string } | null {
  const id = appId();
  const cfg = configId();
  if (!id || !cfg || !appSecret()) return null;
  return { appId: id, configId: cfg, graphVersion: GRAPH_VERSION };
}

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Cambia el `code` de autorización del popup por un access token del WABA del cliente.
 * Es el único paso FATAL: sin token no hay conexión. Lanza Error con un mensaje claro
 * si Meta rechaza el intercambio (código vencido, app mal configurada, etc.).
 */
export async function intercambiarCodigo(code: string): Promise<string> {
  const id = appId();
  const secret = appSecret();
  if (!id || !secret) throw new Error("Embedded Signup no está configurado (falta META_APP_ID / WHATSAPP_APP_SECRET).");

  // El flujo de código del SDK no usa redirect_uri (el token se emite contra la app).
  const q = new URLSearchParams({ client_id: id, client_secret: secret, code });
  const res = await fetch(`${GRAPH}/oauth/access_token?${q}`, { method: "GET" });
  const cuerpo = (await res.json().catch(() => null)) as { access_token?: string; error?: { message?: string } } | null;
  if (!res.ok || !cuerpo?.access_token) {
    const detalle = cuerpo?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`No se pudo canjear el código de Meta: ${detalle}`);
  }
  return cuerpo.access_token;
}

/**
 * Suscribe NUESTRA app a los webhooks del WABA recién conectado. Sin esto no llegan
 * los mensajes entrantes de ese negocio. Best-effort: devuelve false y loguea si
 * falla (no aborta el alta — se puede resuscribir a mano desde WhatsApp Manager).
 */
export async function suscribirApp(wabaId: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${GRAPH}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const detalle = (await res.text()).slice(0, 200);
      console.error(`[embeddedSignup] no se pudo suscribir la app al WABA ${wabaId} (${res.status}): ${detalle}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[embeddedSignup] error suscribiendo la app al WABA ${wabaId}:`, e);
    return false;
  }
}

/**
 * Registra el número en la Cloud API (necesario para enviar/recibir). Requiere un PIN
 * de verificación en dos pasos (WHATSAPP_REGISTER_PIN, 6 dígitos). Best-effort: si no
 * hay PIN configurado se omite, y si el número ya estaba registrado Meta responde con
 * error pero la conexión igual sirve, así que no abortamos el alta.
 */
export async function registrarNumero(phoneNumberId: string, token: string): Promise<boolean> {
  const pin = process.env.WHATSAPP_REGISTER_PIN?.trim();
  if (!pin) {
    console.warn(`[embeddedSignup] sin WHATSAPP_REGISTER_PIN: omito el registro del número ${phoneNumberId}.`);
    return false;
  }
  try {
    const res = await fetch(`${GRAPH}/${encodeURIComponent(phoneNumberId)}/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", pin }),
    });
    if (!res.ok) {
      const detalle = (await res.text()).slice(0, 200);
      console.warn(`[embeddedSignup] no se pudo registrar el número ${phoneNumberId} (${res.status}): ${detalle}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[embeddedSignup] error registrando el número ${phoneNumberId}:`, e);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stash efímero del token. Después de conectar, el token queda del lado del server
// bajo un `handle` opaco (nunca vuelve al navegador — misma política que el resto
// del código: el accessToken es SECRETO y no se expone por la API). El alta canjea
// el handle por el token una sola vez. TTL generoso para dar tiempo a llenar el
// formulario; single-use para que no quede colgado.
// ─────────────────────────────────────────────────────────────────────────────
interface TokenStash {
  token: string;
  phoneNumberId: string;
  wabaId: string;
  expiraEn: number; // epoch ms
}
const TTL_MS = 30 * 60 * 1000; // 30 min
const stash = new Map<string, TokenStash>();

/** Guarda el token bajo un handle nuevo y devuelve el handle. */
export function guardarTokenTemporal(datos: { token: string; phoneNumberId: string; wabaId: string }): string {
  purgarVencidos();
  const handle = crypto.randomBytes(24).toString("base64url");
  stash.set(handle, { ...datos, expiraEn: Date.now() + TTL_MS });
  return handle;
}

/**
 * Canjea un handle por su token (single-use): lo borra al leerlo. Devuelve null si el
 * handle no existe o venció (el caller debe pedir reconectar).
 */
export function tomarToken(handle: string): { token: string; phoneNumberId: string; wabaId: string } | null {
  purgarVencidos();
  const s = stash.get(handle);
  if (!s) return null;
  stash.delete(handle);
  if (Date.now() > s.expiraEn) return null;
  return { token: s.token, phoneNumberId: s.phoneNumberId, wabaId: s.wabaId };
}

function purgarVencidos(): void {
  const ahora = Date.now();
  for (const [h, s] of stash) if (ahora > s.expiraEn) stash.delete(h);
}
