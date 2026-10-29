import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { E2E_DB, TENANTS, USUARIOS } from "./constantes";
import {
  ORIGEN,
  apiAdmin,
  apiComo,
  codigoTotpFresco,
  entrar,
  entrarAdmin,
  enviados,
  graphFalla,
  responderDialogo,
  vigilarConsola,
  webhookTexto,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Superadmin (/panel/admin): login con 2FA (TOTP + anti-replay), lista de negocios,
// cambio de plan, pausar/reactivar (y lo que ve el dueño), reset de clave (y el cambio
// obligatorio), reconectar/probar WhatsApp, borrar un cliente (Ley 8968), historial,
// alta de negocio (manual y por Embedded Signup con el SDK de Facebook simulado),
// tope mensual, DLQ y baja de un negocio.
// ─────────────────────────────────────────────────────────────────────────────

const filaNegocio = (page: Page, id: string) =>
  page.locator(".admin-tabla > tbody > tr").filter({ has: page.locator(`td:nth-child(3)`, { hasText: new RegExp(`^${id}$`) }) });

async function expandir(page: Page, id: string) {
  await filaNegocio(page, id).getByRole("button", { name: "Ver detalle" }).click();
  await expect(page.locator(".admin-acciones")).toBeVisible();
  return page.locator(".admin-tabla > tbody > tr", { has: page.locator(".admin-acciones") });
}

// SDK de Facebook simulado: el popup de Embedded Signup "termina" (o se cancela) solo.
const SDK_FALSO = `
window.FB = {
  init: function () {},
  login: function (cb) {
    setTimeout(function () {
      var evento = window.__esEvento || "FINISH";
      window.dispatchEvent(new MessageEvent("message", {
        origin: "https://www.facebook.com",
        data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: evento, data: { phone_number_id: "1000000099", waba_id: "2000000099" } })
      }));
      if (evento === "FINISH") cb({ authResponse: { code: "codigo-e2e" } });
    }, 50);
  }
};
if (window.fbAsyncInit) window.fbAsyncInit();
`;
async function simularSdkFacebook(context: BrowserContext) {
  await context.route("https://connect.facebook.net/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: SDK_FALSO }));
}

test.describe("login del superadmin (2FA)", () => {
  test("credenciales malas, sin código o código inválido → mismo error y el código se limpia", async ({ page }) => {
    await page.goto("/panel/admin");
    await expect(page.locator("#admin-login")).toBeVisible();
    const error = page.locator(".admin-error");
    await page.locator("#admUsuario").fill(E2E_DB.superadmin.usuario);
    await page.locator("#admPassword").fill("mala-clave");
    await page.locator("#admCodigo").fill("123456");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(error).toHaveText("Usuario, contraseña o código incorrectos");
    await expect(page.locator("#admCodigo")).toHaveValue("");

    await page.locator("#admPassword").fill(E2E_DB.superadmin.password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(error).toHaveText("Usuario, contraseña o código incorrectos");

    await page.locator("#admCodigo").fill("000000");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(error).toHaveText("Usuario, contraseña o código incorrectos");
    await expect(page.locator(".admin-header")).toHaveCount(0);
  });

  test("con el código TOTP correcto entra; Salir vuelve al login; un código ya usado no sirve de nuevo", async ({ page, playwright }) => {
    const errores = vigilarConsola(page);
    await page.goto("/panel/admin");
    await page.locator("#admUsuario").fill(E2E_DB.superadmin.usuario);
    await page.locator("#admPassword").fill(E2E_DB.superadmin.password);
    const codigo = await codigoTotpFresco();
    await page.locator("#admCodigo").fill(codigo.slice(0, 3) + " " + codigo.slice(3)); // con espacio, como lo muestran las apps
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(page.locator(".admin-header h2")).toHaveText("Onboarding de negocios");
    await expect(page.locator(".admin-user")).toHaveText(E2E_DB.superadmin.usuario);
    await expect(page.locator(".admin-aviso", { hasText: "No hay base de datos" })).toHaveCount(0);

    // Replay del mismo código → 401.
    const otro = await playwright.request.newContext({ baseURL: E2E_DB.baseURL });
    const r = await otro.post("/api/panel/admin/login", {
      headers: ORIGEN,
      data: { usuario: E2E_DB.superadmin.usuario, password: E2E_DB.superadmin.password, codigo },
    });
    expect(r.status()).toBe(401);

    await page.locator(".admin-header").getByRole("button", { name: "Salir" }).click();
    await expect(page.locator("#admin-login")).toBeVisible();
    expect((await page.request.get("/api/panel/admin/me")).status()).toBe(401);
    expect(errores, errores.join("\n")).toEqual([]);
  });

  test("las sesiones no se cruzan: operador ≠ superadmin", async ({ page, playwright }) => {
    await entrar(page, USUARIOS.clinica);
    expect((await page.request.get("/api/panel/admin/me")).status()).toBe(401);
    const admin = await apiAdmin(playwright);
    expect((await admin.get("/api/panel/me")).status()).toBe(401);
    expect((await admin.get("/api/panel/admin/me")).status()).toBe(200);
  });
});

test("lista de negocios: activos y pausados, uso del mes, costo y detalle desplegable", async ({ page, context }) => {
  await entrarAdmin(context, page);
  await expect(page.locator(".card h3", { hasText: /^Negocios \(\d+\)$/ })).toBeVisible();
  for (const t of Object.values(TENANTS)) await expect(filaNegocio(page, t.id)).toHaveCount(1);
  const pausado = filaNegocio(page, TENANTS.pausado.id);
  await expect(pausado).toContainText("Pausado");
  await expect(pausado).toContainText("Falta de pago (E2E)");
  await expect(pausado.getByRole("button", { name: "Reactivar" })).toBeVisible();
  await expect(filaNegocio(page, TENANTS.lleno.id).locator("td").nth(6)).toHaveText(/^50\d$/); // 500 sembradas (+ las del E2E)
  await expect(filaNegocio(page, TENANTS.gastoia.id).locator("td").nth(8)).toHaveText("$16.00");
  await expect(filaNegocio(page, TENANTS.clinica.id).locator("select")).toHaveValue("pro");

  const detalle = await expandir(page, TENANTS.clinica.id);
  await expect(detalle.locator("table").first()).toContainText(USUARIOS.clinica.usuario);
  await expect(detalle).toContainText("Conectado con su token propio.");
  await filaNegocio(page, TENANTS.clinica.id).getByRole("button", { name: "Ocultar" }).click();
  await expect(page.locator(".admin-acciones")).toHaveCount(0);
});

test("cambiar plan Básico ↔ Pro: el dueño gana/pierde las features sin reiniciar", async ({ page, context, playwright }) => {
  const dueno = await apiComo(playwright, USUARIOS.gastoia);
  expect((await (await dueno.get("/api/panel/me")).json()).features.campanias).toBe(false);
  await entrarAdmin(context, page);
  const sel = filaNegocio(page, TENANTS.gastoia.id).locator("select");
  await sel.selectOption("pro");
  await expect(sel).toHaveValue("pro");
  await expect.poll(async () => (await (await dueno.get("/api/panel/me")).json()).features.campanias).toBe(true);
  await sel.selectOption("basico");
  await expect.poll(async () => (await (await dueno.get("/api/panel/me")).json()).features.campanias).toBe(false);
  const admin = await apiAdmin(playwright);
  expect((await admin.post(`/api/panel/admin/tenants/${TENANTS.gastoia.id}/plan`, { data: { plan: "oro" } })).status()).toBe(400);
  expect((await admin.post(`/api/panel/admin/tenants/no-existe/plan`, { data: { plan: "pro" } })).status()).toBe(404);
});

test("pausar y reactivar: el prompt se puede cancelar; el dueño ve 'Cuenta pausada' y 'Salir'; luego vuelve", async ({ page, context, browser, playwright }) => {
  // Sesión abierta del dueño de "gastoia" en otro navegador.
  const ctxDueno = await browser.newContext({ baseURL: E2E_DB.baseURL });
  const dueno = await ctxDueno.newPage();
  await entrar(dueno, USUARIOS.gastoia);

  await entrarAdmin(context, page);
  const fila = filaNegocio(page, TENANTS.gastoia.id);
  const cancelar = responderDialogo(page, false);
  await fila.getByRole("button", { name: "Pausar" }).click();
  expect(await cancelar).toContain("Motivo (opcional)");
  await expect(fila).toContainText("Activo");

  const aceptar = responderDialogo(page, true, "Prueba de pausa E2E");
  await fila.getByRole("button", { name: "Pausar" }).click();
  await aceptar;
  await expect(fila).toContainText("Pausado");
  await expect(fila).toContainText("Prueba de pausa E2E");

  // El panel abierto del dueño pasa a "Cuenta pausada" (sin recargar).
  await expect(dueno.getByRole("heading", { name: "Cuenta pausada" })).toBeVisible({ timeout: 15_000 });
  await expect(dueno.getByRole("link", { name: "Escribir a Selyon por WhatsApp" })).toHaveAttribute("href", /wa\.me/);
  await dueno.getByRole("button", { name: "Salir" }).click();
  await expect(dueno.locator("#login")).toBeVisible();

  // Pausar dos veces → 409.
  const admin = await apiAdmin(playwright);
  expect((await admin.post(`/api/panel/admin/tenants/${TENANTS.gastoia.id}/pausar`, { data: {} })).status()).toBe(409);

  const reactivar = responderDialogo(page, true, "Pagó (E2E)");
  await fila.getByRole("button", { name: "Reactivar" }).click();
  expect(await reactivar).toContain("Reactivar");
  await expect(fila).toContainText("Activo");
  await entrar(dueno, USUARIOS.gastoia);
  await expect(dueno.locator(".hd-nombre")).toHaveText(TENANTS.gastoia.nombre);
  await ctxDueno.close();
});

test.describe.serial("reset de clave → cambio obligatorio", () => {
  let claveTemporal = "";
  const nuevaClave = "MiClaveNueva-e2e-1";

  test("el superadmin resetea (con confirmación) y ve la clave temporal una sola vez", async ({ page, context }) => {
    await entrarAdmin(context, page);
    const detalle = await expandir(page, TENANTS.clinica.id);
    const filaUsr = detalle.locator("tr", { hasText: USUARIOS.clinicaReset.usuario });
    const cancelar = responderDialogo(page, false);
    await filaUsr.getByRole("button", { name: "Resetear clave" }).click();
    expect(await cancelar).toContain(USUARIOS.clinicaReset.usuario);
    await expect(detalle.locator(".admin-ok")).toHaveCount(0);

    const aceptar = responderDialogo(page, true);
    await filaUsr.getByRole("button", { name: "Resetear clave" }).click();
    await aceptar;
    const ok = detalle.locator(".admin-ok", { hasText: "Clave temporal para" });
    await expect(ok).toContainText(USUARIOS.clinicaReset.usuario);
    claveTemporal = (await ok.locator("code").textContent())!.trim();
    expect(claveTemporal.length).toBeGreaterThanOrEqual(8);
  });

  test("la clave vieja ya no sirve; con la temporal se fuerza el cambio (validaciones) y luego entra", async ({ page }) => {
    await page.goto("/panel");
    await page.locator("#usuario").fill(USUARIOS.clinicaReset.usuario);
    await page.locator("#password").fill(USUARIOS.clinicaReset.password);
    await page.getByRole("button", { name: "Entrar →" }).click();
    await expect(page.locator("#loginError")).toHaveText("Usuario o contraseña incorrectos");

    await page.locator("#password").fill(claveTemporal);
    await page.getByRole("button", { name: "Entrar →" }).click();
    await expect(page.getByRole("heading", { name: "Cambiá tu clave" })).toBeVisible();
    await expect(page.locator("#app")).toHaveCount(0);

    const enviar = page.getByRole("button", { name: "Cambiar clave →" });
    await page.locator("#claveActual").fill(claveTemporal);
    await page.locator("#claveNueva").fill("corta");
    await page.locator("#claveConfirmar").fill("corta");
    await enviar.click();
    await expect(page.locator("#loginError")).toHaveText("La contraseña nueva debe tener al menos 8 caracteres");
    await page.locator("#claveNueva").fill(nuevaClave);
    await page.locator("#claveConfirmar").fill(nuevaClave + "x");
    await enviar.click();
    await expect(page.locator("#loginError")).toHaveText("Las contraseñas nuevas no coinciden");
    await page.locator("#claveActual").fill("no-es-la-temporal");
    await page.locator("#claveConfirmar").fill(nuevaClave);
    await enviar.click();
    await expect(page.locator("#loginError")).toHaveText("La contraseña actual no es correcta");
    await page.locator("#claveActual").fill(claveTemporal);
    await enviar.click();
    await expect(page.locator("#app")).toBeVisible();

    await page.getByRole("button", { name: "Salir" }).click();
    await entrar(page, { ...USUARIOS.clinicaReset, password: nuevaClave });
  });
});

test("reset de clave: la fila del equipo marca 'clave temporal pendiente' sin recargar", async ({ page, context }) => {
  await entrarAdmin(context, page);
  const detalle = await expandir(page, TENANTS.lleno.id);
  const filaUsr = detalle.locator("tr", { hasText: USUARIOS.llenoOp.usuario });
  await expect(filaUsr).not.toContainText("clave temporal pendiente");
  const ok = responderDialogo(page, true);
  await filaUsr.getByRole("button", { name: "Resetear clave" }).click();
  await ok;
  await expect(detalle.locator(".admin-ok", { hasText: "Clave temporal para" })).toBeVisible();
  await expect(filaUsr, "la tabla del equipo queda desactualizada tras el reset").toContainText("clave temporal pendiente");
});

test.describe.serial("WhatsApp del negocio, borrado de cliente e historial", () => {
  test("reconectar: cancelar, validaciones (pnid, token), guardar OK y pnid de otro negocio → 409", async ({ page, context }) => {
    await entrarAdmin(context, page);
    const detalle = await expandir(page, TENANTS.basico.id);
    const card = detalle.locator(".card", { hasText: "WhatsApp" }).first();
    const pnid = card.locator(`#rPnid-${TENANTS.basico.id}`);
    await expect(pnid).toHaveValue(TENANTS.basico.pnid);
    const token = card.locator(`#rToken-${TENANTS.basico.id}`);
    const boton = card.getByRole("button", { name: "Reconectar WhatsApp" });

    await token.fill("EAAe2eTokenNuevoBasico1234567890");
    const cancelar = responderDialogo(page, false);
    await boton.click();
    expect(await cancelar).toContain("Reemplazar la conexión");

    await pnid.fill("abc");
    let ok = responderDialogo(page, true);
    await boton.click();
    await ok;
    await expect(card.locator(".admin-error")).toContainText("phone_number_id debe ser numérico");

    await pnid.fill(TENANTS.basico.pnid);
    await token.fill("corto");
    ok = responderDialogo(page, true);
    await boton.click();
    await ok;
    await expect(card.locator(".admin-error")).toContainText("no tiene un formato válido");

    await pnid.fill(TENANTS.clinica.pnid); // ya es de otro negocio
    await token.fill("EAAe2eTokenNuevoBasico1234567890");
    ok = responderDialogo(page, true);
    await boton.click();
    await ok;
    await expect(card.locator(".admin-error")).toBeVisible();

    await pnid.fill(TENANTS.basico.pnid);
    ok = responderDialogo(page, true);
    await boton.click();
    await ok;
    await expect(card.locator(".admin-ok")).toHaveText("Conexión guardada. Probala con un mensaje de prueba.");
    await expect(token).toHaveValue(""); // el token no queda en pantalla
  });

  test("mensaje de prueba: número inválido, envío OK por el número del negocio y error de Graph visible", async ({ page, context }) => {
    await entrarAdmin(context, page);
    const detalle = await expandir(page, TENANTS.basico.id);
    const card = detalle.locator(".card", { hasText: "WhatsApp" }).first();
    const para = card.locator(`#rPara-${TENANTS.basico.id}`);
    const boton = card.getByRole("button", { name: "Enviar mensaje de prueba" });
    await para.fill("123");
    await boton.click();
    await expect(card.locator(".admin-error")).toContainText("Número de destino inválido");

    await para.fill("50688889999");
    await boton.click();
    await expect(card.locator(".admin-ok")).toHaveText("Mensaje de prueba enviado.");
    const ultimo = (await enviados(page.request)).filter((e) => e.to === "50688889999").at(-1);
    expect(ultimo?.phoneNumberId).toBe(TENANTS.basico.pnid);
    expect(ultimo?.texto).toContain("Barbería Básica");

    await graphFalla(page.request, true);
    try {
      await boton.click();
      await expect(card.locator(".admin-error")).toContainText("Graph respondió:");
      await expect(card.locator(".admin-error")).toContainText("131047");
    } finally {
      await graphFalla(page.request, false);
    }
  });

  test("borrar datos de un cliente desde el admin: confirmación que no coincide → error; OK → conteos", async ({ page, context, playwright }) => {
    const wa = "50677770020";
    await webhookTexto(page.request, { pnid: TENANTS.clinica.pnid, clienteWa: wa, texto: "Quiero que borren mis datos" });
    const dueno = await apiComo(playwright, USUARIOS.clinica);
    await expect
      .poll(async () => ((await (await dueno.get("/api/panel/conversaciones")).json()).conversaciones as { clienteWa: string }[]).some((c) => c.clienteWa === wa), { timeout: 15_000 })
      .toBe(true);

    await entrarAdmin(context, page);
    const detalle = await expandir(page, TENANTS.clinica.id);
    const card = detalle.locator(".card", { hasText: "Borrar datos de un cliente" });
    await card.locator(`#bTel-${TENANTS.clinica.id}`).fill(wa);
    await card.locator(`#bConf-${TENANTS.clinica.id}`).fill("50600000000");
    let ok = responderDialogo(page, true);
    await card.getByRole("button", { name: "Borrar datos del cliente" }).click();
    await ok;
    await expect(card.locator(".admin-error")).toContainText("La confirmación no coincide");

    await card.locator(`#bConf-${TENANTS.clinica.id}`).fill(wa);
    ok = responderDialogo(page, true);
    await card.getByRole("button", { name: "Borrar datos del cliente" }).click();
    await ok;
    await expect(card.locator(".admin-ok")).toContainText(/Listo: [1-9]\d* mensajes/);
    await expect(card.locator(`#bTel-${TENANTS.clinica.id}`)).toHaveValue("");
    const convs = (await (await dueno.get("/api/panel/conversaciones")).json()).conversaciones as { clienteWa: string }[];
    expect(convs.some((c) => c.clienteWa === wa)).toBe(false);
  });

  test("historial auditable: Ver/Ocultar y las acciones de plataforma quedan registradas", async ({ page, context }) => {
    await entrarAdmin(context, page);
    let detalle = await expandir(page, TENANTS.basico.id);
    let card = detalle.locator(".card", { hasText: "Historial" });
    await card.getByRole("button", { name: "Ver historial" }).click();
    await expect(card.locator("tbody tr", { hasText: "WhatsApp reconectado" }).first()).toBeVisible();
    await card.getByRole("button", { name: "Ocultar historial" }).click();
    await expect(card.locator("table")).toHaveCount(0);
    await filaNegocio(page, TENANTS.basico.id).getByRole("button", { name: "Ocultar" }).click();

    detalle = await expandir(page, TENANTS.gastoia.id);
    card = detalle.locator(".card", { hasText: "Historial" });
    await card.getByRole("button", { name: "Ver historial" }).click();
    await expect(card.locator("tbody tr", { hasText: "Pausado" }).first()).toContainText("Prueba de pausa E2E");
    await expect(card.locator("tbody tr", { hasText: "Reactivado" }).first()).toBeVisible();
    await filaNegocio(page, TENANTS.gastoia.id).getByRole("button", { name: "Ocultar" }).click();

    detalle = await expandir(page, TENANTS.clinica.id);
    card = detalle.locator(".card", { hasText: "Historial" });
    await card.getByRole("button", { name: "Ver historial" }).click();
    await expect(card.locator("tbody tr", { hasText: "Datos de un cliente borrados" }).first()).toBeVisible();
  });
});

test.describe.serial("alta de negocio", () => {
  const NUEVO = { nombre: "Panadería Ñandú E2E", id: "panaderia-nandu-e2e", usuario: "panaderia-e2e", password: "Panaderia-e2e-123", pnid: "1000000077" };

  test("formulario manual: slug automático, validaciones y alta OK (la lista se actualiza y el form se limpia)", async ({ page, context }) => {
    await entrarAdmin(context, page);
    const form = page.locator("form.admin-form");
    await page.locator("#oNombre").fill(NUEVO.nombre);
    await expect(page.locator("#oId")).toHaveValue(NUEVO.id);
    // Con Embedded Signup configurado, la carga manual va dentro de "avanzado".
    await expect(page.getByRole("button", { name: "Conectar WhatsApp con Meta" })).toBeVisible();
    await page.locator("summary", { hasText: "Conectar manualmente (avanzado)" }).click();
    await page.locator("#oPnid").fill(NUEVO.pnid);
    await page.locator("#oUbic").fill("Cartago centro");
    await page.locator("#oUsuario").fill(NUEVO.usuario);
    await page.locator("#oPass").fill(NUEVO.password);

    // Sin token → aviso en el cliente, sin llamar al backend.
    await form.getByRole("button", { name: "Crear negocio" }).click();
    await expect(form.locator(".admin-error")).toHaveText("Falta el access token de WhatsApp (o conectá el número con Meta).");

    await page.locator("#oToken").fill("EAAe2ePanaderiaToken1234567890");
    await page.locator("#oAbre").fill("07:00");
    await page.locator("#oCierra").fill("17:00");
    await form.locator(".admin-dia", { hasText: "Dom" }).locator("input").uncheck();
    await page.locator("#oIntervalo").fill("15");
    await page.locator("#oMoneda").fill("₡");
    // Servicios: agregar dos, quitar uno.
    await form.getByRole("button", { name: "+ Agregar servicio" }).click();
    await form.getByRole("button", { name: "+ Agregar servicio" }).click();
    const s0 = form.locator(".admin-servicio").nth(0);
    await s0.getByPlaceholder("nombre").fill("Pan Casero");
    await s0.getByPlaceholder("precio", { exact: true }).fill("1500");
    await s0.getByPlaceholder("duración (min)").fill("20");
    await s0.locator(".admin-check", { hasText: "precio variable" }).locator("input").check();
    await expect(s0.getByPlaceholder("precio", { exact: true })).toBeDisabled();
    await s0.locator(".admin-check", { hasText: "precio variable" }).locator("input").uncheck();
    await s0.getByPlaceholder("nota de precio / descripción").fill("recién horneado");
    await form.locator(".admin-servicio").nth(1).getByRole("button", { name: "Quitar" }).click();
    await expect(form.locator(".admin-servicio")).toHaveCount(1);
    // Perfil + KB + FAQ.
    await page.locator("#oTipoNegocio").fill("una panadería");
    await page.locator("#oPais").fill("Costa Rica");
    await page.locator("#oRegistro").selectOption("tu");
    await page.locator("#oTono").fill("dulce");
    await page.locator("#oFormasPago").fill("SINPE");
    await page.locator("#oInstrucciones").fill("- Pedidos con un día de anticipación");
    await form.locator(".kb-grupo").nth(0).getByRole("button", { name: "+ Agregar dato" }).click();
    await form.locator(".kb-grupo").nth(0).locator(".kb-item-input").last().fill("Abrimos temprano");
    await form.locator(".kb-grupo").nth(1).getByRole("button", { name: "+ Agregar política" }).click();
    await form.locator(".kb-grupo").nth(1).locator(".kb-item-input").last().fill("No hay devoluciones");
    await form.locator(".kb-grupo").nth(2).getByRole("button", { name: "Agregar sección" }).first().click();
    await form.locator(".kb-seccion-titulo").fill("Menú");
    await form.locator(".kb-seccion .kb-item-input").first().fill("Pan dulce ₡1000");
    await form.getByRole("button", { name: "+ Agregar pregunta" }).click();
    await form.locator(".admin-faq").locator("input").nth(0).fill("¿Hacen envíos?");
    await form.locator(".admin-faq").locator("input").nth(1).fill("Sí, en Cartago");

    await form.getByRole("button", { name: "Crear negocio" }).click();
    await expect(form.locator(".admin-ok")).toHaveText(`✅ Negocio "${NUEVO.id}" creado. Ya puede entrar al panel con su usuario.`);
    await expect(filaNegocio(page, NUEVO.id)).toHaveCount(1);
    await expect(page.locator("#oNombre")).toHaveValue("");
    await expect(page.locator("#oUsuario")).toHaveValue("");
  });

  test("el dueño del negocio nuevo entra y ve su configuración tal como se cargó", async ({ page, playwright }) => {
    await entrar(page, { usuario: NUEVO.usuario, password: NUEVO.password, rol: "dueno", tenantId: NUEVO.id });
    await expect(page.locator(".hd-nombre")).toHaveText(NUEVO.nombre);
    const api = await apiComo(playwright, { usuario: NUEVO.usuario, password: NUEVO.password, rol: "dueno", tenantId: NUEVO.id });
    const cfg = await (await api.get("/api/panel/config")).json();
    expect(cfg.servicios).toEqual([{ id: "pan-casero", nombre: "Pan Casero", precio: 1500, duracionMin: 20, agendable: true, precioNota: "recién horneado" }]);
    expect(cfg.horario[0]).toEqual({ abre: null, cierra: null });
    expect(cfg.horario[1]).toEqual({ abre: "07:00", cierra: "17:00" });
    expect(cfg.kb.faq).toEqual([{ pregunta: "¿Hacen envíos?", respuesta: "Sí, en Cartago" }]);
    expect(cfg.kb.secciones[0]).toMatchObject({ titulo: "Menú", items: ["Pan dulce ₡1000"] });
    expect(cfg).toMatchObject({ tipoNegocio: "una panadería", pais: "Costa Rica", registro: "tu", tono: "dulce", formasPago: "SINPE" });
  });

  test("duplicados y datos inválidos → error claro del backend", async ({ playwright }) => {
    const admin = await apiAdmin(playwright);
    const base = {
      tenant: { id: NUEVO.id, nombre: "Otro", phoneNumberId: "1000000088", accessToken: "EAAe2eOtroToken12345678901", ubicacion: "x", horario: {}, servicios: [], kb: { faq: [], datos: [], politicas: [] } },
      usuario: "otro-usuario-e2e",
      password: "Otro-e2e-1234",
    };
    const dupId = await admin.post("/api/panel/admin/tenants", { data: base });
    expect(dupId.status()).toBe(409);
    const dupUsuario = await admin.post("/api/panel/admin/tenants", { data: { ...base, tenant: { ...base.tenant, id: "otro-id-e2e" }, usuario: NUEVO.usuario } });
    expect(dupUsuario.status()).toBe(409);
    const dupPnid = await admin.post("/api/panel/admin/tenants", { data: { ...base, tenant: { ...base.tenant, id: "otro-id-2-e2e", phoneNumberId: NUEVO.pnid } } });
    expect(dupPnid.status()).toBe(409);
    const claveCorta = await admin.post("/api/panel/admin/tenants", { data: { ...base, tenant: { ...base.tenant, id: "otro-id-3-e2e" }, password: "corta" } });
    expect(claveCorta.status()).toBe(400);
    const idMalo = await admin.post("/api/panel/admin/tenants", { data: { ...base, tenant: { ...base.tenant, id: "Con Espacios" } } });
    expect(idMalo.status()).toBe(400);
  });

  test("la UI muestra el 409 de un duplicado", async ({ page, context }) => {
    await entrarAdmin(context, page);
    await page.locator("#oNombre").fill(NUEVO.nombre); // mismo slug
    await page.locator("summary", { hasText: "Conectar manualmente (avanzado)" }).click();
    await page.locator("#oPnid").fill("1000000066");
    await page.locator("#oToken").fill("EAAe2eDuplicadoToken123456789");
    await page.locator("#oUbic").fill("x");
    await page.locator("#oUsuario").fill("duplicado-e2e");
    await page.locator("#oPass").fill("Duplicado-e2e-1");
    await page.getByRole("button", { name: "Crear negocio" }).click();
    await expect(page.locator("form.admin-form .admin-error")).toBeVisible();
    await expect(page.locator("form.admin-form .admin-ok")).toHaveCount(0);
  });
});

test.describe.serial("alta por Embedded Signup (SDK de Facebook simulado) y baja del negocio", () => {
  const ES = { nombre: "Ferretería ES E2E", id: "ferreteria-es-e2e", usuario: "ferreteria-e2e", password: "Ferreteria-e2e-1" };

  test("cancelar el popup de Meta muestra 'Conexión cancelada.'", async ({ page, context }) => {
    await simularSdkFacebook(context);
    await entrarAdmin(context, page);
    await page.evaluate(() => ((window as unknown as { __esEvento: string }).__esEvento = "CANCEL"));
    await page.getByRole("button", { name: "Conectar WhatsApp con Meta" }).click();
    await expect(page.locator(".admin-conectar .admin-error")).toHaveText("Conexión cancelada.");
    await expect(page.getByRole("button", { name: "Conectar WhatsApp con Meta" })).toBeEnabled();
  });

  test("conectar con Meta: número conectado (sin token en el navegador), aviso de registro, 'Cambiar' y alta OK", async ({ page, context }) => {
    await simularSdkFacebook(context);
    await entrarAdmin(context, page);
    const tokenEnRed: string[] = [];
    page.on("response", async (r) => {
      if (r.url().includes("/embedded-signup/conectar")) tokenEnRed.push(await r.text());
    });
    await page.getByRole("button", { name: "Conectar WhatsApp con Meta" }).click();
    const conectado = page.locator(".admin-conectado");
    await expect(conectado).toContainText("Número conectado (phone_number_id 1000000099)");
    await expect(conectado.locator(".admin-aviso")).toContainText("el número quedó sin registrar");
    expect(tokenEnRed.join("")).not.toContain("EAAe2eEmbeddedSignupToken"); // solo viaja un handle opaco

    await conectado.getByRole("button", { name: "Cambiar" }).click();
    await expect(page.getByRole("button", { name: "Conectar WhatsApp con Meta" })).toBeVisible();
    await page.getByRole("button", { name: "Conectar WhatsApp con Meta" }).click();
    await expect(conectado).toBeVisible();

    await page.locator("#oNombre").fill(ES.nombre);
    await page.locator("#oUbic").fill("Heredia");
    await page.locator("#oUsuario").fill(ES.usuario);
    await page.locator("#oPass").fill(ES.password);
    await page.getByRole("button", { name: "Crear negocio" }).click();
    await expect(page.locator("form.admin-form .admin-ok")).toContainText(`"${ES.id}" creado`);
    await expect(filaNegocio(page, ES.id)).toContainText("1000000099");
  });

  test("baja del negocio (offboarding): exige el nombre exacto, exporta y lo quita de la lista", async ({ playwright, page, context }) => {
    const admin = await apiAdmin(playwright);
    const mal = await admin.post(`/api/panel/admin/tenants/${ES.id}/baja`, { data: { confirmarNombre: "otro nombre" } });
    expect(mal.status()).toBe(400);
    expect((await admin.post(`/api/panel/admin/tenants/${ES.id}/baja`, { data: {} })).status()).toBe(400);
    const ok = await admin.post(`/api/panel/admin/tenants/${ES.id}/baja`, { data: { confirmarNombre: ES.nombre } });
    expect(ok.status(), await ok.text()).toBe(200);
    expect((await ok.json()).export).toBeTruthy();
    await entrarAdmin(context, page);
    await expect(filaNegocio(page, ES.id)).toHaveCount(0);
    const login = await playwright.request.newContext({ baseURL: E2E_DB.baseURL });
    const r = await login.post("/api/panel/login", { headers: ORIGEN, data: { usuario: ES.usuario, password: ES.password } });
    expect(r.status()).toBe(401);
  });
});

test("tope mensual: el superadmin lo desactiva (el aviso al dueño desaparece) y lo vuelve a activar", async ({ playwright }) => {
  const admin = await apiAdmin(playwright);
  const dueno = await apiComo(playwright, USUARIOS.lleno);
  expect((await (await dueno.get("/api/panel/me")).json()).cuotaMensual.excedido).toBe(true);
  expect((await admin.post(`/api/panel/admin/tenants/${TENANTS.lleno.id}/tope`, { data: { desactivado: true } })).status()).toBe(200);
  expect((await (await dueno.get("/api/panel/me")).json()).cuotaMensual.tope).toBeNull();
  expect((await admin.post(`/api/panel/admin/tenants/${TENANTS.lleno.id}/tope`, { data: { desactivado: false } })).status()).toBe(200);
  expect((await (await dueno.get("/api/panel/me")).json()).cuotaMensual.excedido).toBe(true);
});

test("DLQ: lista vacía y reencolar un job inexistente → 409; rutas desconocidas → 404", async ({ playwright }) => {
  const admin = await apiAdmin(playwright);
  const dlq = await admin.get("/api/panel/admin/dlq");
  expect(dlq.status()).toBe(200);
  expect(Array.isArray((await dlq.json()).tenants)).toBe(true);
  expect((await admin.post("/api/panel/admin/dlq/00000000-0000-0000-0000-000000000000/reencolar")).status()).toBe(409);
  expect((await admin.get("/api/panel/admin/no-existe")).status()).toBe(404);
  expect((await admin.get(`/api/panel/admin/tenants/no-existe/usuarios`)).status()).toBe(404);
  expect((await admin.post(`/api/panel/admin/usuarios/no-existe/reset-password`)).status()).toBe(404);
  // Sin sesión de admin, todo admin/* → 401.
  const anon = await playwright.request.newContext({ baseURL: E2E_DB.baseURL });
  expect((await anon.get("/api/panel/admin/tenants")).status()).toBe(401);
});
