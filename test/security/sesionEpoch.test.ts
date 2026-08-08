import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";

// ─────────────────────────────────────────────────────────────────────────────
// E13/ALTO-06 — Revocación de sesiones del panel.
//
// El token de sesión (src/panel/auth.ts) es HMAC stateless: por sí solo NUNCA sabe si
// la cuenta cambió después de firmarse. `sesionDeOperador` (src/panel/router.ts) es la
// pieza que cierra ese hueco: en CADA request revalida el token contra la cuenta VIVA
// en el caché (tenantStore) — si la cuenta fue desactivada, cambió de rol, o le
// resetearon la clave (todo eso sube `sessionEpoch`), un token firmado ANTES de ese
// cambio deja de calzar y la sesión se trata como inválida, sin esperar a que expire
// (hasta 7 días).
//
// No se levanta Postgres: se usa `cargarTenants()` SIN DATABASE_URL para poblar el
// tenant fallback ("selyon") en el caché, y `_registrarUsuarioParaTests` (mismo espíritu
// que `_registrarTenantParaTests` de otros módulos) para inyectar cuentas de prueba
// directo en el caché en memoria — así se prueba la revalidación real sin mockear nada
// de tenantStore ni depender de una base efímera.
//
// PANEL_SESSION_SECRET se fija ANTES de importar auth.ts/router.ts (que lo leen en el
// load), igual que en seguridad.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

process.env.PANEL_SESSION_SECRET = "test-epoch-session-secret-0123456789";
process.env.PANEL_SESSION_VERSION = "1";
delete process.env.DATABASE_URL; // cargarTenants() debe caer al fallback en memoria

const { crearSesion } = await import("../../src/panel/auth");
const { cargarTenants, _registrarUsuarioParaTests } = await import("../../src/config/tenantStore");
const { sesionDeOperador } = await import("../../src/panel/router");

await cargarTenants(); // sin DATABASE_URL → puebla cache.porId con el tenant fallback "selyon"

const TENANT_ID = "selyon"; // id de TENANT_FALLBACK_SELYON (src/config/tenants.ts)
const COOKIE = "panel_sesion"; // mismo nombre que router.ts (no se exporta la constante)

/** Cuenta de prueba con los defaults típicos; cada test pisa lo que necesita. */
function cuenta(extra: Partial<Parameters<typeof _registrarUsuarioParaTests>[1]> = {}) {
  return {
    id: "usr-test",
    tenantId: TENANT_ID,
    passwordHash: "irrelevante:para-este-test",
    rol: "operador" as const,
    debeCambiarClave: false,
    claveTemporalExpira: null,
    activo: true,
    sessionEpoch: 0,
    ...extra,
  };
}

/** Construye un IncomingMessage mínimo con la cookie de sesión — sesionDeOperador solo lee headers.cookie. */
function reqConToken(token: string): IncomingMessage {
  return { headers: { cookie: `${COOKIE}=${token}` } } as unknown as IncomingMessage;
}

test("token viejo con epoch anterior es rechazado tras un reset de clave", () => {
  const usuario = "epoch-reset@test";
  // El token se firmó cuando la cuenta estaba en epoch 4 (antes del reset).
  const token = crearSesion(TENANT_ID, "usr-reset", "operador", 4);
  // El reset de clave (resetearClaveUsuario) subió el epoch a 5 y el router refrescó el
  // caché (recargar()) — simulamos ese estado post-reset directo en el caché.
  _registrarUsuarioParaTests(usuario, cuenta({ id: "usr-reset", sessionEpoch: 5 }));

  assert.equal(sesionDeOperador(reqConToken(token)), null, "el token pre-reset (epoch 4) no debe pasar contra epoch vigente 5");
});

test("usuario desactivado no puede seguir usando su sesión vieja", () => {
  const usuario = "desactivado@test";
  const token = crearSesion(TENANT_ID, "usr-baja", "operador", 2);
  // Mismo epoch que el token (el epoch por sí solo no alcanza): lo que debe cortar la
  // sesión es `!usuario.activo`, no un epoch desalineado.
  _registrarUsuarioParaTests(usuario, cuenta({ id: "usr-baja", sessionEpoch: 2, activo: false }));

  assert.equal(sesionDeOperador(reqConToken(token)), null, "una cuenta desactivada no debe poder seguir usando su sesión");
});

test("un cambio de rol se refleja inmediatamente, aunque el token diga el rol viejo", () => {
  const usuario = "cambio-rol@test";
  // El token quedó firmado como "dueno" (rol vigente al momento del login)...
  const token = crearSesion(TENANT_ID, "usr-rol", "dueno", 1);
  // ...pero la cuenta VIVA ahora es "operador" (mismo epoch: se aísla el chequeo de rol
  // del de epoch — acá interesa probar puntualmente que el rol sale de la cuenta viva).
  _registrarUsuarioParaTests(usuario, cuenta({ id: "usr-rol", rol: "operador", sessionEpoch: 1 }));

  const sesion = sesionDeOperador(reqConToken(token));
  assert.ok(sesion, "la sesión debería seguir siendo válida (mismo epoch)");
  assert.equal(sesion?.rol, "operador", "el rol debe salir de la cuenta viva (tenantStore), no del token");
});

test("login normal NO invalida otras sesiones del mismo usuario en otros dispositivos", () => {
  const usuario = "multi-dispositivo@test";
  _registrarUsuarioParaTests(usuario, cuenta({ id: "usr-multi", sessionEpoch: 3 }));

  // "Login" en el dispositivo A: firma con el epoch vigente (3).
  const tokenDispositivoA = crearSesion(TENANT_ID, "usr-multi", "operador", 3);
  assert.ok(sesionDeOperador(reqConToken(tokenDispositivoA)), "dispositivo A debería estar autenticado");

  // "Login" en el dispositivo B, MISMA cuenta: el login no sube el epoch (router.ts no
  // llama ningún incrementarEpoch en /login), así que sigue firmando con epoch 3.
  const tokenDispositivoB = crearSesion(TENANT_ID, "usr-multi", "operador", 3);
  assert.ok(sesionDeOperador(reqConToken(tokenDispositivoB)), "dispositivo B debería estar autenticado");

  // La sesión de A sigue viva: loguearse en B no la revocó.
  assert.ok(sesionDeOperador(reqConToken(tokenDispositivoA)), "dispositivo A NO debería haberse invalidado por el login de B");
});

test("sesionDeOperador: cuenta inexistente (no está en el caché) → null", () => {
  const token = crearSesion(TENANT_ID, "usr-nunca-existio", "operador", 0);
  assert.equal(sesionDeOperador(reqConToken(token)), null);
});

test("sesionDeOperador: sin cookie → null", () => {
  assert.equal(sesionDeOperador({ headers: {} } as unknown as IncomingMessage), null);
});
