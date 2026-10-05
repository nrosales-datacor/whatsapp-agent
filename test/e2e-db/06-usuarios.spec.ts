import { test, expect, type Page } from "@playwright/test";
import { E2E_DB, USUARIOS } from "./constantes";
import { ORIGEN, apiComo, entrar, esperarToast, responderDialogo } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// "Usuarios" (C2.3, Pro, solo dueño): alta con validaciones, duplicados, cambio de rol
// y (des)activación con confirmación, protección contra auto-lockout y "último dueño",
// revocación de sesiones al cambiar rol/estado, y vista móvil.
// ─────────────────────────────────────────────────────────────────────────────

const NUEVO = { usuario: "nuevo-op-e2e", password: "NuevoOp-e2e-123" };

async function abrirUsuarios(page: Page) {
  await page.locator(".hd-tab", { hasText: "Usuarios" }).click();
  await expect(page.locator("#usuarios .us-content")).toBeVisible();
}
const fila = (page: Page, usuario: string) => page.locator(".us-tabla-desktop tbody tr", { hasText: usuario });

test.describe.serial("gestión de usuarios", () => {
  test("lista del equipo: la propia fila dice '(vos)' y sus controles están deshabilitados", async ({ page }) => {
    await entrar(page, USUARIOS.clinica);
    await abrirUsuarios(page);
    await expect(page.locator(".us-chip-count")).toHaveText(String(await page.locator(".us-tabla-desktop tbody tr").count()));
    const yo = fila(page, USUARIOS.clinica.usuario).filter({ hasText: "(vos)" });
    await expect(yo).toHaveCount(1);
    await expect(yo.locator("select")).toBeDisabled();
    await expect(yo.getByRole("button", { name: "Desactivar" })).toBeDisabled();
    await expect(fila(page, USUARIOS.clinicaOp.usuario).locator("select")).toHaveValue("operador");
    await expect(fila(page, USUARIOS.clinicaOp.usuario).locator(".us-estado-chip")).toHaveText("Activo");
  });

  test("último dueño activo: la API no deja degradarlo ni desactivarlo", async ({ playwright }) => {
    const api = await apiComo(playwright, USUARIOS.clinica);
    const yo = ((await (await api.get("/api/panel/usuarios")).json()).usuarios as { id: string; usuario: string }[]).find(
      (u) => u.usuario === USUARIOS.clinica.usuario,
    )!;
    for (const patch of [{ rol: "operador" }, { activo: false }]) {
      const r = await api.post(`/api/panel/usuarios/${yo.id}`, { data: patch });
      expect(r.status()).toBe(400);
      expect((await r.json()).error).toBe("Debe quedar al menos un dueño activo");
    }
    expect((await api.post(`/api/panel/usuarios/${yo.id}`, { data: {} })).status()).toBe(400);
    expect((await api.post(`/api/panel/usuarios/${yo.id}`, { data: { rol: "admin" } })).status()).toBe(400);
  });

  test("alta: validaciones en el cliente, mostrar clave, alta OK (campos se limpian) y duplicado → 409", async ({ page }) => {
    await entrar(page, USUARIOS.clinica);
    await abrirUsuarios(page);
    const agregar = page.getByRole("button", { name: "Agregar usuario" });

    await page.locator("#uNuevoUsuario").fill("con espacio");
    await page.locator("#uNuevaPass").fill("larga-suficiente");
    await agregar.click();
    await esperarToast(page, "Usuario inválido");

    await page.locator("#uNuevoUsuario").fill(NUEVO.usuario);
    await page.locator("#uNuevaPass").fill("corta");
    await agregar.click();
    await esperarToast(page, "al menos 8 caracteres");

    await page.locator("#uNuevaPass").fill(NUEVO.password);
    await expect(page.locator("#uNuevaPass")).toHaveAttribute("type", "password");
    await page.locator("#usuarios").getByRole("button", { name: "Mostrar contraseña" }).click();
    await expect(page.locator("#uNuevaPass")).toHaveAttribute("type", "text");
    await expect(page.locator("#uNuevoRol")).toHaveValue("operador");
    await agregar.click();
    await esperarToast(page, "Usuario creado");
    await expect(fila(page, NUEVO.usuario)).toHaveCount(1);
    await expect(page.locator("#uNuevoUsuario")).toHaveValue("");
    await expect(page.locator("#uNuevaPass")).toHaveValue("");
    await expect(page.locator("#uNuevaPass")).toHaveAttribute("type", "password");

    await page.locator("#uNuevoUsuario").fill(NUEVO.usuario);
    await page.locator("#uNuevaPass").fill(NUEVO.password);
    await agregar.click();
    await esperarToast(page, "Ese usuario de panel ya existe");

    // El usuario del superadmin responde igual que uno existente (no se revela).
    await page.locator("#uNuevoUsuario").fill(E2E_DB.superadmin.usuario);
    await page.locator("#uNuevaPass").fill(NUEVO.password);
    await agregar.click();
    await esperarToast(page, "Ese usuario de panel ya existe");
  });

  test("el usuario nuevo entra como operador (sin pestañas de dueño)", async ({ page }) => {
    await entrar(page, { ...NUEVO, rol: "operador", tenantId: "clinica" });
    await expect(page.locator(".hd-tab", { hasText: "Inbox" })).toBeVisible();
    await expect(page.locator(".hd-tab", { hasText: "Mi negocio" })).toHaveCount(0);
  });

  test("cambiar rol: cancelar no cambia nada; aceptar lo promueve y REVOCA su sesión abierta", async ({ page, browser }) => {
    // Sesión abierta del usuario nuevo en otro navegador.
    const otro = await browser.newContext({ baseURL: E2E_DB.baseURL });
    const suPagina = await otro.newPage();
    await entrar(suPagina, { ...NUEVO, rol: "operador", tenantId: "clinica" });

    await entrar(page, USUARIOS.clinica);
    await abrirUsuarios(page);
    const sel = fila(page, NUEVO.usuario).locator("select");
    const cancelar = responderDialogo(page, false);
    await sel.selectOption("dueno");
    expect(await cancelar).toContain(`"${NUEVO.usuario}"`);
    await expect(sel).toHaveValue("operador");

    const aceptar = responderDialogo(page, true);
    await sel.selectOption("dueno");
    await aceptar;
    await expect(sel).toHaveValue("dueno");
    await expect(fila(page, NUEVO.usuario).locator(".us-avatar")).toHaveClass(/us-avatar-dueno/);

    // Su sesión vieja (rol operador) quedó revocada → al próximo request cae al login.
    await expect(suPagina.locator("#login")).toBeVisible({ timeout: 15_000 });
    await otro.close();
  });

  test("desactivar: confirmación, no puede entrar; reactivar: vuelve a entrar", async ({ page, playwright }) => {
    await entrar(page, USUARIOS.clinica);
    await abrirUsuarios(page);
    const f = fila(page, NUEVO.usuario);
    const cancelar = responderDialogo(page, false);
    await f.getByRole("button", { name: "Desactivar" }).click();
    expect(await cancelar).toContain("No podrá volver a iniciar sesión");
    await expect(f.locator(".us-estado-chip")).toHaveText("Activo");

    const aceptar = responderDialogo(page, true);
    await f.getByRole("button", { name: "Desactivar" }).click();
    await aceptar;
    await expect(f.locator(".us-estado-chip")).toHaveText("Inactivo");
    await expect(f.getByRole("button", { name: "Reactivar" })).toBeVisible();

    const login = await playwright.request.newContext({ baseURL: E2E_DB.baseURL });
    const r = await login.post("/api/panel/login", { headers: ORIGEN, data: { usuario: NUEVO.usuario, password: NUEVO.password } });
    expect(r.status()).toBe(401);
    expect((await r.json()).error).toBe("Usuario o contraseña incorrectos");

    const reactivar = responderDialogo(page, true);
    await f.getByRole("button", { name: "Reactivar" }).click();
    expect(await reactivar).toContain("Reactivar");
    await expect(f.locator(".us-estado-chip")).toHaveText("Activo");
    const r2 = await login.post("/api/panel/login", { headers: ORIGEN, data: { usuario: NUEVO.usuario, password: NUEVO.password } });
    expect(r2.status()).toBe(200);
  });

  test("móvil: el equipo se muestra como tarjetas con sus controles", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await entrar(page, USUARIOS.clinica);
    await abrirUsuarios(page);
    await expect(page.locator(".us-tabla-desktop")).toBeHidden();
    const tarjeta = page.locator(".us-card-movil", { hasText: USUARIOS.clinicaOp.usuario });
    await expect(tarjeta).toBeVisible();
    await expect(tarjeta.locator("select")).toBeVisible();
    await expect(tarjeta.getByRole("button", { name: "Desactivar" })).toBeVisible();
  });
});

test("operador y plan Básico: /usuarios responde 403 (rol y plan)", async ({ playwright }) => {
  const op = await apiComo(playwright, USUARIOS.clinicaOp);
  expect((await op.get("/api/panel/usuarios")).status()).toBe(403);
  const basico = await apiComo(playwright, USUARIOS.basico);
  const r = await basico.get("/api/panel/usuarios");
  expect(r.status()).toBe(403);
  expect((await r.json()).error).toBe("plan_requerido");
});
