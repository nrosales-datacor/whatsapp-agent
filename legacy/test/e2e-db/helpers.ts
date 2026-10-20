import crypto from "node:crypto";
import { expect, type APIRequestContext, type BrowserContext, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { decodificarBase32, pasoTotp, totp } from "../../src/panel/totp";
import { E2E_DB, firmarWebhook, type UsuarioE2E } from "./constantes";

type Playwright = PlaywrightWorkerArgs["playwright"];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de las specs del E2E con base de datos (ver servidor.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const ORIGEN = { origin: E2E_DB.baseURL };

/** Login por la UI real (formulario de /panel). */
export async function entrarUI(page: Page, u: UsuarioE2E) {
  await page.goto("/panel");
  await page.locator("#usuario").fill(u.usuario);
  await page.locator("#password").fill(u.password);
  await page.getByRole("button", { name: "Entrar →" }).click();
  await expect(page.locator("#app")).toBeVisible();
}

/**
 * Login por la API compartiendo las cookies del contexto del navegador (page.request):
 * más rápido que el formulario para las specs que no prueban el login en sí.
 */
export async function entrar(page: Page, u: UsuarioE2E, ruta = "/panel") {
  const res = await page.request.post("/api/panel/login", { headers: ORIGEN, data: { usuario: u.usuario, password: u.password } });
  expect(res.status(), await res.text()).toBe(200);
  await page.goto(ruta);
  if (ruta === "/panel") await expect(page.locator("#app")).toBeVisible();
}

/**
 * Contexto de API NUEVO autenticado como `u` (cookie + Origin fijos en cada request),
 * para preparar/verificar estado sin la UI. Aislado del navegador: no pisa su sesión.
 */
export async function apiComo(pw: Playwright, u: UsuarioE2E): Promise<APIRequestContext> {
  const login = await pw.request.newContext({ baseURL: E2E_DB.baseURL });
  const res = await login.post("/api/panel/login", { headers: ORIGEN, data: { usuario: u.usuario, password: u.password } });
  expect(res.status(), await res.text()).toBe(200);
  const cookie = /panel_sesion=[^;]+/.exec(res.headers()["set-cookie"] ?? "")?.[0];
  expect(cookie, "el login no devolvió cookie de sesión").toBeTruthy();
  await login.dispose();
  return pw.request.newContext({ baseURL: E2E_DB.baseURL, extraHTTPHeaders: { cookie: cookie!, ...ORIGEN } });
}

/** Contexto de API del superadmin (cookie minteada con 2FA). */
export async function apiAdmin(pw: Playwright): Promise<APIRequestContext> {
  return pw.request.newContext({ baseURL: E2E_DB.baseURL, extraHTTPHeaders: headersAdmin() });
}

// ── Superadmin ──

/** Cookie de superadmin minteada (con 2FA, porque el server E2E tiene TOTP activo). */
export function cookieAdmin(): string {
  const exp = Date.now() + 60 * 60 * 1000;
  const payload = `__superadmin__.${exp}.1.1.1`;
  const firma = crypto.createHmac("sha256", E2E_DB.secret).update(payload).digest("hex");
  return Buffer.from(`${payload}.${firma}`).toString("base64url");
}

export async function entrarAdmin(context: BrowserContext, page: Page) {
  await context.addCookies([
    { name: "panel_admin_sesion", value: cookieAdmin(), domain: "localhost", path: "/", httpOnly: true, secure: true, sameSite: "Strict" },
  ]);
  await page.goto("/panel/admin");
  await expect(page.locator(".admin-header")).toBeVisible();
}

export function headersAdmin(): Record<string, string> {
  return { cookie: `panel_admin_sesion=${cookieAdmin()}`, ...ORIGEN };
}

// Anti-replay del TOTP: el server rechaza un código de un paso ya usado. Se recuerda el
// último paso consumido EN ESTE PROCESO de specs y, si hace falta, se espera al próximo.
let ultimoPasoUsado = -1;
export async function codigoTotpFresco(): Promise<string> {
  const clave = decodificarBase32(E2E_DB.totpSecret)!;
  let paso = pasoTotp(Date.now());
  while (paso <= ultimoPasoUsado) {
    await new Promise((r) => setTimeout(r, 500));
    paso = pasoTotp(Date.now());
  }
  ultimoPasoUsado = paso;
  return totp(clave, Date.now());
}

// ── Mock de red (servidor de control) ──

export interface EnviadoWa {
  tipo: string;
  to: string;
  texto?: string;
  plantilla?: string;
  phoneNumberId: string;
  raw: any;
}

export async function enviados(request: APIRequestContext): Promise<EnviadoWa[]> {
  const res = await request.get(`${E2E_DB.controlURL}/enviados`);
  return res.json();
}

export async function graphFalla(request: APIRequestContext, fallar: boolean) {
  await request.get(`${E2E_DB.controlURL}/graph?fallar=${fallar ? 1 : 0}`);
}

export async function estadoRed(request: APIRequestContext): Promise<{ llamadasLLM: number; pushes: number }> {
  return (await request.get(`${E2E_DB.controlURL}/estado`)).json();
}

// ── Webhook simulado (Meta → server) ──

let seqWamid = 0;
export async function webhookTexto(
  request: APIRequestContext,
  opts: { pnid: string; clienteWa: string; texto?: string; interactiveId?: string; titulo?: string },
) {
  const id = `wamid.e2e.in.${Date.now()}.${++seqWamid}`;
  const mensaje = opts.interactiveId
    ? { from: opts.clienteWa, id, type: "interactive", interactive: { type: "button_reply", button_reply: { id: opts.interactiveId, title: opts.titulo ?? "Sí" } } }
    : { from: opts.clienteWa, id, type: "text", text: { body: opts.texto ?? "Hola" } };
  const cuerpo = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: opts.pnid }, messages: [mensaje] } }] }],
  });
  const res = await request.post("/webhook", {
    headers: { "content-type": "application/json", "x-hub-signature-256": firmarWebhook(cuerpo) },
    data: cuerpo,
  });
  expect(res.status(), await res.text()).toBe(200);
  return id;
}

// ── Fechas ──

/** "YYYY-MM-DD" de hoy en la zona del negocio sembrado (Costa Rica). */
export function hoyCR(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Costa_Rica" });
}

export function sumarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Acepta (o rechaza) el PRÓXIMO diálogo nativo (confirm/prompt/alert), con texto opcional. */
export function responderDialogo(page: Page, aceptar: boolean, texto?: string): Promise<string> {
  return new Promise((resolve) => {
    page.once("dialog", async (d) => {
      const msg = d.message();
      if (aceptar) await d.accept(texto);
      else await d.dismiss();
      resolve(msg);
    });
  });
}

/** Junta errores de consola/página que SÍ son bugs (filtra ruido de red/PWA benigno). */
export function vigilarConsola(page: Page): string[] {
  const errores: string[] = [];
  const benigno = /favicon|manifest|service worker|Failed to load resource|net::ERR|the server responded with a status of (4|5)\d\d/i;
  page.on("pageerror", (e) => errores.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !benigno.test(m.text())) errores.push("console: " + m.text());
  });
  return errores;
}

/** Toast visible con ese texto (los toasts duran ~3 s). */
export async function esperarToast(page: Page, texto: string | RegExp) {
  await expect(page.locator("#toasts .toast-txt").filter({ hasText: texto }).first()).toBeVisible();
}
