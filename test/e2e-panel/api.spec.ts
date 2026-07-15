import { test, expect, type APIRequestContext } from "@playwright/test";
import crypto from "node:crypto";
import { E2E } from "./constantes";

// ─────────────────────────────────────────────────────────────────────────────
// E2E de la API del panel (/api/panel/*) y de los assets PWA. Cubre lo que NO es
// visual: guards de rol (403), CSRF (mismo origen), y el ciclo CRUD de la agenda.
// No basta con esconder pestañas en el front → se prueba pegándole directo a la API.
// ─────────────────────────────────────────────────────────────────────────────

// Mintea una cookie de sesión firmada, igual que src/panel/auth.ts::crearSesion. El
// server E2E corre con este mismo PANEL_SESSION_SECRET, así podemos probar los guards
// de rol sin que el usuario exista en la base (en modo memoria no hay tabla de usuarios).
function mintSesion(rol: "operador" | "dueno"): string {
  const exp = Date.now() + 60 * 60 * 1000;
  const ver = "1"; // PANEL_SESSION_VERSION por defecto
  const payload = `${E2E.tenantId}.usr-e2e.${rol}.${exp}.${ver}`;
  const firma = crypto.createHmac("sha256", E2E.secret).update(payload).digest("hex");
  return Buffer.from(`${payload}.${firma}`).toString("base64url");
}

const cookie = (rol: "operador" | "dueno") => `panel_sesion=${mintSesion(rol)}`;
const fechaFutura = (dias: number) => new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);

// Mintea una cookie de superadmin (onboarding), igual que auth.ts::crearSesionAdmin.
// verificarSesionAdmin solo valida firma+versión+vencimiento (no depende del .env), así
// que con el mismo secreto podemos ejercer las rutas /api/panel/admin/*.
function mintAdmin(): string {
  const exp = Date.now() + 60 * 60 * 1000;
  const payload = `__superadmin__.${exp}.1`;
  const firma = crypto.createHmac("sha256", E2E.secret).update(payload).digest("hex");
  return `panel_admin_sesion=${Buffer.from(`${payload}.${firma}`).toString("base64url")}`;
}

// Helpers de la agenda (POST autenticado como dueño, mismo origen).
async function crearCita(request: APIRequestContext, fecha: string, hora: string) {
  const res = await request.post("/api/panel/citas", {
    headers: { cookie: cookie("dueno"), origin: E2E.baseURL },
    data: { clienteNombre: "Cliente E2E", clienteWa: "50600000000", servicioId: "pulido_focos", fecha, hora },
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  return body.cita.id as string;
}
async function accionCita(request: APIRequestContext, id: string, accion: string, data?: unknown) {
  return request.post(`/api/panel/citas/${id}/${accion}`, {
    headers: { cookie: cookie("dueno"), origin: E2E.baseURL },
    data: data ?? {},
  });
}

test.describe("CSRF (mismo origen en los POST)", () => {
  test("POST con Origin ajeno → 403", async ({ request }) => {
    const res = await request.post("/api/panel/login", {
      headers: { origin: "http://attacker.example" },
      data: { usuario: E2E.usuario, password: E2E.password },
    });
    expect(res.status()).toBe(403);
  });

  test("POST con Origin del mismo host pasa el guard CSRF (y falla por credenciales)", async ({ request }) => {
    const res = await request.post("/api/panel/login", {
      headers: { origin: E2E.baseURL },
      data: { usuario: E2E.usuario, password: "mala" },
    });
    expect(res.status()).toBe(401); // pasó CSRF, cayó en auth
  });
});

test.describe("Guards de rol (no basta con esconder la pestaña)", () => {
  test("operador recibe 403 en GET /usuarios; dueño pasa el guard de rol", async ({ request }) => {
    const op = await request.get("/api/panel/usuarios", { headers: { cookie: cookie("operador") } });
    expect(op.status()).toBe(403);

    // El dueño PASA el guard de rol; en modo memoria cae en el check de base de datos
    // (503). Códigos distintos ⇒ el 403 del operador es por ROL, no por falta de DB.
    const dueno = await request.get("/api/panel/usuarios", { headers: { cookie: cookie("dueno") } });
    expect(dueno.status()).toBe(503);
  });

  test("operador recibe 403 en POST /config; dueño pasa el guard de rol", async ({ request }) => {
    const op = await request.post("/api/panel/config", {
      headers: { cookie: cookie("operador"), origin: E2E.baseURL },
      data: { horario: {}, servicios: [] },
    });
    expect(op.status()).toBe(403);

    const dueno = await request.post("/api/panel/config", {
      headers: { cookie: cookie("dueno"), origin: E2E.baseURL },
      data: { horario: {}, servicios: [] },
    });
    expect(dueno.status()).toBe(503);
  });

  test("una cookie de sesión minteada es aceptada por /me", async ({ request }) => {
    const res = await request.get("/api/panel/me", { headers: { cookie: cookie("dueno") } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.rol).toBe("dueno");
  });
});

test.describe("Seguridad: el accessToken de WhatsApp nunca vuelve al navegador (C4.2, ángulo 8)", () => {
  // El accessToken es el secreto más sensible del tenant: quien lo tenga puede enviar
  // mensajes en su nombre. Ninguna respuesta de la API que consume el frontend debe
  // incluirlo. Sembramos un token conocido en el server E2E y afirmamos que no aparece.
  const TOKEN = "e2e-token-dummy"; // = WHATSAPP_ACCESS_TOKEN del server E2E (ver servidor.ts)

  test("GET admin/tenants no expone accessToken en el resumen", async ({ request }) => {
    const res = await request.get("/api/panel/admin/tenants", { headers: { cookie: mintAdmin() } });
    expect(res.status()).toBe(200);
    const texto = await res.text();
    expect(texto).not.toContain("accessToken");
    expect(texto).not.toContain(TOKEN);
    for (const t of (await res.json()).tenants) expect(t.accessToken).toBeUndefined();
  });

  test("GET me y GET config (dueño) no exponen accessToken", async ({ request }) => {
    const me = await request.get("/api/panel/me", { headers: { cookie: cookie("dueno") } });
    expect(me.status()).toBe(200);
    expect(await me.text()).not.toContain(TOKEN);
    expect((await me.json()).accessToken).toBeUndefined();

    const cfg = await request.get("/api/panel/config", { headers: { cookie: cookie("dueno") } });
    expect(cfg.status()).toBe(200);
    const cfgTexto = await cfg.text();
    expect(cfgTexto).not.toContain("accessToken");
    expect(cfgTexto).not.toContain(TOKEN);
  });
});

test.describe("Assets PWA", () => {
  test("service worker: 200 + Service-Worker-Allowed: /panel/", async ({ request }) => {
    const res = await request.get("/panel/sw.js");
    expect(res.status()).toBe(200);
    expect(res.headers()["service-worker-allowed"]).toBe("/panel/");
    expect(res.headers()["content-type"]).toContain("javascript");
  });

  test("manifest e íconos se sirven", async ({ request }) => {
    const manifest = await request.get("/panel/manifest.webmanifest");
    expect(manifest.status()).toBe(200);
    expect(manifest.headers()["content-type"]).toContain("manifest");

    const icono = await request.get("/panel/icons/icon-192.png");
    expect(icono.status()).toBe(200);
    expect(icono.headers()["content-type"]).toBe("image/png");
  });
});

test.describe("Agenda: ciclo CRUD por la API", () => {
  test("crear → confirmar → reprogramar → completar", async ({ request }) => {
    const id = await crearCita(request, fechaFutura(30), "10:00");

    const conf = await accionCita(request, id, "confirmar");
    expect(conf.status()).toBe(200);
    expect((await conf.json()).cita.confirmadaEn).toBeTruthy();

    const repro = await accionCita(request, id, "reprogramar", { fecha: fechaFutura(31), hora: "11:00" });
    expect(repro.status()).toBe(200);
    expect((await repro.json()).cita.fecha).toBe(fechaFutura(31));

    const comp = await accionCita(request, id, "completar");
    expect(comp.status()).toBe(200);
    expect((await comp.json()).ok).toBe(true);
  });

  test("crear → no-show y crear → cancelar", async ({ request }) => {
    const idNoShow = await crearCita(request, fechaFutura(32), "09:00");
    const ns = await accionCita(request, idNoShow, "no-show");
    expect(ns.status()).toBe(200);
    expect((await ns.json()).ok).toBe(true);

    const idCancel = await crearCita(request, fechaFutura(33), "09:00");
    const can = await accionCita(request, idCancel, "cancelar");
    expect(can.status()).toBe(200);
    expect((await can.json()).ok).toBe(true);
  });
});
