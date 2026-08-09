import { test, expect, type APIRequestContext } from "@playwright/test";
import crypto from "node:crypto";
import { E2E } from "./constantes";

// ─────────────────────────────────────────────────────────────────────────────
// E2E de la API del panel (/api/panel/*) y de los assets PWA. Cubre lo que NO es
// visual: guards de rol (403), CSRF (mismo origen), y el ciclo CRUD de la agenda.
// No basta con esconder pestañas en el front → se prueba pegándole directo a la API.
// ─────────────────────────────────────────────────────────────────────────────

// Mintea una cookie de sesión firmada, igual que src/panel/auth.ts::crearSesion. El
// server E2E corre con este mismo PANEL_SESSION_SECRET, así que la firma calza sin pasar
// por el login real. El usuarioId (usr-e2e-<rol>) SÍ tiene que existir como cuenta viva en
// el caché en memoria: E13/ALTO-06 hizo que `sesionDeOperador` revalide cada request
// contra `obtenerUsuarioPorId` (no confía en el rol firmado en el token) — servidor.ts
// registra esas dos cuentas (una por rol) vía `_registrarUsuarioParaTests`, con
// `sessionEpoch: 0`, que es el epoch que se firma acá abajo.
function mintSesion(rol: "operador" | "dueno"): string {
  const exp = Date.now() + 60 * 60 * 1000;
  const epoch = 0;
  const ver = "1"; // PANEL_SESSION_VERSION por defecto
  const payload = `${E2E.tenantId}.usr-e2e-${rol}.${rol}.${epoch}.${exp}.${ver}`;
  const firma = crypto.createHmac("sha256", E2E.secret).update(payload).digest("hex");
  return Buffer.from(`${payload}.${firma}`).toString("base64url");
}

const cookie = (rol: "operador" | "dueno") => `panel_sesion=${mintSesion(rol)}`;
// El tenant de demo cierra fines de semana (src/config/tenants.ts: horario[0]/[6] = cerrado).
// Un offset de CALENDARIO fijo (Date.now() + N días) cae en sábado/domingo ~2 de cada 7 días
// según en qué fecha corra el CI, y ahí "disponibilidad" legítimamente devuelve 0 slots — no
// es un bug de la app, es que el test pedía un día cerrado. Contamos días HÁBILES en vez de
// calendario: además de nunca caer en fin de semana, sigue siendo estrictamente creciente en
// `dias` (offsets distintos → fechas distintas), así que las citas que crean varios tests con
// offsets consecutivos (30..36) no colisionan entre sí por fecha+hora.
function fechaFutura(diasHabiles: number): string {
  let d = new Date();
  let restantes = diasHabiles;
  while (restantes > 0) {
    d = new Date(d.getTime() + 86_400_000);
    const diaSemana = d.getDay(); // 0 = domingo, 6 = sábado
    if (diaSemana !== 0 && diaSemana !== 6) restantes--;
  }
  return d.toISOString().slice(0, 10);
}

// Mintea una cookie de superadmin (onboarding), igual que auth.ts::crearSesionAdmin.
// verificarSesionAdmin solo valida firma+versión+vencimiento (no depende del .env), así
// que con el mismo secreto podemos ejercer las rutas /api/panel/admin/*.
function mintAdmin(): string {
  const exp = Date.now() + 60 * 60 * 1000;
  const payload = `__superadmin__.${exp}.1`;
  const firma = crypto.createHmac("sha256", E2E.secret).update(payload).digest("hex");
  return `panel_admin_sesion=${Buffer.from(`${payload}.${firma}`).toString("base64url")}`;
}

// El servicioId NO se hardcodea: se lee del tenant vivo por `GET /me` (que ya devuelve
// solo los agendables). El catálogo lo define el seed de demo y ya cambió de rubro dos
// veces — fijarlo acá rompe este E2E cada vez que cambia (pasó con `pulido_focos` y
// después con `reunion-diagnostico`). Se cachea: es el mismo tenant en toda la corrida.
let servicioAgendable: string | null = null;
async function primerServicioAgendable(request: APIRequestContext): Promise<string> {
  if (servicioAgendable) return servicioAgendable;
  const res = await request.get("/api/panel/me", { headers: { cookie: cookie("dueno") } });
  expect(res.status(), await res.text()).toBe(200);
  const servicios = (await res.json()).servicios as { id: string }[];
  expect(servicios?.length ?? 0, "el tenant de la demo no tiene servicios agendables").toBeGreaterThan(0);
  servicioAgendable = servicios[0].id;
  return servicioAgendable;
}

// Helpers de la agenda (POST autenticado como dueño, mismo origen).
async function crearCita(request: APIRequestContext, fecha: string, hora: string) {
  const servicioId = await primerServicioAgendable(request);
  const res = await request.post("/api/panel/citas", {
    headers: { cookie: cookie("dueno"), origin: E2E.baseURL },
    data: { clienteNombre: "Cliente E2E", clienteWa: "50600000000", servicioId, fecha, hora },
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

// Google Calendar por negocio (auditoría BLOQ-05): el calendario dejó de ser una env
// global compartida por todos los tenants. El panel necesita dos cosas del backend: el
// calendario del propio negocio y el email de la service account (para que el dueño sepa
// a quién compartírselo), y el POST tiene que rechazar valores que reabrirían la fuga.
test.describe("Google Calendar por negocio (BLOQ-05)", () => {
  test("GET config expone el calendario del negocio y la service account", async ({ request }) => {
    const res = await request.get("/api/panel/config", { headers: { cookie: cookie("dueno") } });
    expect(res.status()).toBe(200);
    const cfg = await res.json();
    // El tenant de demo no tiene calendario configurado → cadena vacía, no undefined:
    // el form del panel necesita un valor controlado.
    expect(cfg.googleCalendarId).toBe("");
    expect(typeof cfg.calendarioServiceAccount).toBe("string");
  });

  // La validación del valor (rechazar "primary" y cualquier cosa que no tenga forma de
  // correo) NO se puede probar acá: `POST /config` corta con 503 "requiere base de datos"
  // ANTES de llegar a los validadores, y el server E2E corre en memoria. Ese caso vive en
  // test/unit/validadores.test.ts → "validarGoogleCalendarId", que es su nivel correcto.
  test("POST config sin base de datos no persiste nada (503, no 200)", async ({ request }) => {
    const res = await request.post("/api/panel/config", {
      headers: { cookie: cookie("dueno"), origin: E2E.baseURL }, // el POST valida el Origin (CSRF)
      data: {
        horario: {},
        servicios: [],
        kb: { faq: [], datos: [], politicas: [], secciones: [] },
        bloqueos: [],
        googleCalendarId: "negocio@gmail.com",
      },
    });
    expect(res.status()).toBe(503);
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

  // Equipo que atiende (ALTO-07). El tenant de este harness corre SIN base y sin equipo
  // cargado, así que acá solo se verifica el CABLEADO HTTP de lo nuevo (rutas, validación,
  // forma de la respuesta) y que el modo "un solo recurso" siga intacto. La regla de
  // capacidad en sí se prueba donde corresponde: test/unit/availability.test.ts (motor),
  // test/unit/agenteEquipo.test.ts (guards del agente) y test/reliability/empleados.test.ts
  // (el índice único, contra Postgres real).
  test("sin equipo cargado, la disponibilidad no asigna a nadie", async ({ request }) => {
    const servicioId = await primerServicioAgendable(request);
    const res = await request.get(`/api/panel/citas/disponibilidad?fecha=${fechaFutura(34)}&servicioId=${servicioId}`, {
      headers: { cookie: cookie("dueno") },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.libres.length).toBeGreaterThan(0);
    // `espacios` es el detalle nuevo: misma cantidad que `libres`, sin nadie a quien asignar.
    expect(body.espacios).toHaveLength(body.libres.length);
    expect(body.espacios[0].empleados).toEqual([]);
  });

  test("POST /citas rechaza un empleadoId que no existe en el negocio", async ({ request }) => {
    const servicioId = await primerServicioAgendable(request);
    const res = await request.post("/api/panel/citas", {
      headers: { cookie: cookie("dueno"), origin: E2E.baseURL },
      data: {
        clienteNombre: "Cliente E2E",
        clienteWa: "50600000000",
        servicioId,
        fecha: fechaFutura(35),
        hora: "10:00",
        empleadoId: "no-existe",
      },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/no existe/i);
  });

  test("POST /citas/{id}/asignar está cableado y valida la persona", async ({ request }) => {
    const id = await crearCita(request, fechaFutura(36), "10:00");
    const malo = await accionCita(request, id, "asignar", { empleadoId: "no-existe" });
    expect(malo.status()).toBe(400);
    // Vacío = dejar sin asignar; siempre permitido, y prueba que la ruta responde 200.
    const vacio = await accionCita(request, id, "asignar", { empleadoId: "" });
    expect(vacio.status()).toBe(200);
    expect((await vacio.json()).cita.empleadoId).toBeUndefined();
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
