import { expect, test, type Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// E2E del shell del panel (I0.7) contra la API simulada (proyecto "panel-mock": Vite en
// modo mock, ver playwright.config.ts). Recorre login, layout, rutas, menú por rol y
// plan, sucursal, móvil y superadmin. Las cuentas son las ficticias de
// web/src/lib/mockApi.ts; el estado del mock vive en sessionStorage, así que cada test
// arranca limpio.
// ─────────────────────────────────────────────────────────────────────────────

const PASSWORD = "demo1234";
const TOTP_CODE = "123456";

async function login(page: Page, email: string) {
  await page.goto("/panel/login");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Clave", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

const heading = (page: Page, name: string, level = 1) => page.getByRole("heading", { level, name, exact: true });

test("sin sesión, /panel lleva al login y vuelve a la página pedida después de entrar", async ({ page }) => {
  await page.goto("/panel/agenda");
  await expect(page).toHaveURL(/\/panel\/login$/);
  await expect(heading(page, "Ingresá a tu panel")).toBeVisible();

  await page.getByLabel("Correo", { exact: true }).fill("duena@demo.test");
  await page.getByLabel("Clave", { exact: true }).fill("otra-clave");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Correo o clave incorrectos." })).toBeVisible();

  await page.getByLabel("Clave", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).toHaveURL(/\/panel\/agenda$/);
  await expect(heading(page, "Agenda")).toBeVisible();
});

test("dueña Pro: recorre todas las secciones del menú con la terminología del negocio", async ({ page }) => {
  await login(page, "duena@demo.test");
  await expect(heading(page, "Inicio")).toBeVisible();
  await expect(page).toHaveTitle("Inicio · Selyon CRM");

  const nav = page.getByRole("navigation", { name: "Principal" });
  // La clínica usa "pacientes" en vez de "clientes".
  const sections: [string, string][] = [
    ["Agenda", "/panel/agenda"],
    ["Pacientes", "/panel/clients"],
    ["Ventas", "/panel/sales"],
    ["Reportes", "/panel/reports"],
    ["WhatsApp IA", "/panel/whatsapp"],
    ["Campañas", "/panel/campaigns"],
    ["Inicio", "/panel"],
  ];
  for (const [name, path] of sections) {
    await nav.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(heading(page, name)).toBeVisible();
    // Inicio, Agenda, Clientes (I1), WhatsApp IA (I2) y Ventas (I4) ya tienen contenido (ver
    // agenda/clients/whatsapp/sales.panel.spec.ts); el resto, el estado de la etapa.
    if (!["/panel", "/panel/agenda", "/panel/clients", "/panel/whatsapp", "/panel/sales"].includes(path)) await expect(page.getByText("Esto llega en la próxima etapa")).toBeVisible();
  }

  await nav.getByRole("link", { name: "Configuración", exact: true }).click();
  await expect(page).toHaveURL(/\/panel\/settings\/business$/);
  await expect(heading(page, "Configuración")).toBeVisible();
  await expect(heading(page, "Negocio", 2)).toBeVisible();
  await page.getByRole("navigation", { name: "Secciones de configuración" }).getByRole("link", { name: "Equipo" }).click();
  await expect(heading(page, "Equipo", 2)).toBeVisible();

  // Ficha por URL (enlazable desde una notificación).
  await page.goto("/panel/clients/123");
  await expect(heading(page, "Ficha del paciente")).toBeVisible();
});

test("sucursal: dueña elige entre Todas y cada una, y queda recordada", async ({ page }) => {
  await login(page, "duena@demo.test");
  const select = page.getByLabel("Sucursal", { exact: true });
  const subtitle = page.locator(".page-subtitle");
  await expect(select).toHaveValue("all");
  await expect(subtitle).toHaveText("Todas las sucursales");

  await select.selectOption({ label: "Escazú" });
  await expect(subtitle).toHaveText("Sucursal: Escazú");
  await page.reload();
  await expect(subtitle).toHaveText("Sucursal: Escazú");
});

test("selector de negocio: cambia de negocio, de marca y de plan", async ({ page }) => {
  await login(page, "duena@demo.test");
  await page.getByRole("button", { name: /Cambiar de negocio/ }).click();
  await page.getByRole("menuitem", { name: /Estética Aurora/ }).click();
  await expect(page.getByText("Ahora estás en Estética Aurora.")).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Principal" });
  // Estética Aurora está en Básico y usa la terminología default.
  await expect(nav.getByRole("link", { name: "Clientes", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Ventas (disponible en el plan Pro)" })).toBeVisible();
});

test("plan Básico: Ventas, Reportes y Campañas con candado abren el aviso del plan Pro", async ({ page }) => {
  await login(page, "basico@demo.test");
  const nav = page.getByRole("navigation", { name: "Principal" });
  await expect(nav.getByRole("link", { name: "WhatsApp IA" })).toBeVisible();

  await nav.getByRole("button", { name: "Reportes (disponible en el plan Pro)" }).click();
  const dialog = page.getByRole("dialog", { name: "Disponible en el plan Pro" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Reportes es parte del plan Pro");
  await dialog.getByRole("button", { name: "Entendido" }).click();
  await expect(dialog).toBeHidden();

  // Por URL tampoco se entra: se explica.
  await page.goto("/panel/sales");
  await expect(heading(page, "Ventas")).toBeVisible();
  await expect(page.getByText("Disponible en el plan Pro")).toBeVisible();

  // "+ Nuevo" ofrece cita y cliente, sin cobro.
  await page.getByRole("button", { name: "Nuevo" }).click();
  await expect(page.getByRole("menuitem", { name: /Cita/ })).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("menuitem", { name: /Cobro/ })).toHaveCount(0);
});

test("Pro sin agente: WhatsApp IA no aparece en el menú", async ({ page }) => {
  await login(page, "sinagente@demo.test");
  const nav = page.getByRole("navigation", { name: "Principal" });
  await expect(nav.getByRole("link", { name: "Ventas" })).toBeVisible();
  await expect(nav.getByText("WhatsApp IA")).toHaveCount(0);
});

test("profesional: Mi agenda, Mis pacientes y Mis comisiones, fijo a su sucursal", async ({ page }) => {
  await login(page, "profesional@demo.test");
  await expect(page).toHaveURL(/\/panel\/agenda$/);
  await expect(heading(page, "Mi agenda")).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Principal" });
  await expect(nav.getByRole("link")).toHaveText(["Mi agenda", "Mis pacientes", "Mis comisiones"]);
  await expect(page.getByLabel("Sucursal", { exact: true })).toHaveCount(0);
  await expect(page.locator(".page-subtitle")).toHaveText("Sucursal: Heredia");

  await page.goto("/panel/reports");
  await expect(page).toHaveURL(/\/panel\/agenda$/);
});

test("2FA: el login pide el código de la app", async ({ page }) => {
  await login(page, "2fa@demo.test");
  await expect(heading(page, "Verificación en dos pasos")).toBeVisible();
  await page.getByLabel("Código", { exact: true }).fill("000000");
  await page.getByRole("button", { name: "Verificar y entrar" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "El código no es correcto" })).toBeVisible();
  await page.getByLabel("Código", { exact: true }).fill(TOTP_CODE);
  await page.getByRole("button", { name: "Verificar y entrar" }).click();
  await expect(heading(page, "Inicio")).toBeVisible();
});

test("cuenta sin negocio activo: el login explica por qué no entra", async ({ page }) => {
  await login(page, "sinnegocio@demo.test");
  await expect(page.getByRole("alert").filter({ hasText: "no tiene acceso a ningún negocio activo" })).toBeVisible();
  await expect(page).toHaveURL(/\/panel\/login$/);
});

test("clave temporal: obliga a cambiarla antes de ver el panel", async ({ page }) => {
  await login(page, "temporal@demo.test");
  await expect(page).toHaveURL(/\/panel\/change-password$/);
  await expect(heading(page, "Elegí una clave nueva")).toBeVisible();
  await page.goto("/panel/agenda");
  await expect(page).toHaveURL(/\/panel\/change-password$/);

  await page.getByLabel("Clave temporal", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Clave nueva", { exact: true }).fill("una-clave-nueva");
  await page.getByLabel("Repetí la clave nueva", { exact: true }).fill("una-clave-nueva");
  await page.getByRole("button", { name: "Guardar clave" }).click();
  await expect(heading(page, "Inicio")).toBeVisible();
  await expect(page.getByText("Listo, tu clave quedó cambiada.")).toBeVisible();
});

test("invitación a una cuenta nueva y recuperación de clave", async ({ page }) => {
  // El enlace del correo: /panel/accept-invitation?token=…
  await page.goto("/panel/accept-invitation?token=demo");
  await expect(heading(page, "Sumate a Clínica Dental Sonrisa")).toBeVisible();
  await page.getByLabel("Tu nombre", { exact: true }).fill("Ana Pérez");
  await page.getByLabel("Clave", { exact: true }).fill("clave-de-ana");
  await page.getByLabel("Repetí la clave", { exact: true }).fill("clave-de-ana");
  await page.getByRole("button", { name: "Aceptar invitación" }).click();
  await expect(heading(page, "Mi agenda")).toBeVisible();

  // Ya usada: no está disponible. El alias /invite/:token lleva a la ruta nueva.
  await page.goto("/panel/invite/demo");
  await expect(page).toHaveURL(/\/panel\/accept-invitation\?token=demo$/);
  await expect(heading(page, "Esta invitación no está disponible")).toBeVisible();

  await page.goto("/panel/reset-password?token=abc");
  await page.getByLabel("Clave nueva", { exact: true }).fill("clave-nueva-1");
  await page.getByLabel("Repetí la clave", { exact: true }).fill("clave-nueva-1");
  await page.getByRole("button", { name: "Guardar clave" }).click();
  await expect(heading(page, "Listo, tu clave quedó cambiada")).toBeVisible();
});

test("invitación a una cuenta que ya existe: confirma con su clave y su código de 2FA", async ({ page }) => {
  await page.goto("/panel/accept-invitation?token=cuenta-existente");
  await expect(heading(page, "Sumate a Estética Aurora")).toBeVisible();
  await expect(page.getByLabel("Tu nombre")).toHaveCount(0);

  await page.getByLabel("Tu clave actual", { exact: true }).fill("otra-clave");
  await page.getByRole("button", { name: "Aceptar invitación" }).click();
  await expect(page.getByText("La clave no es correcta: usá la clave con la que ya entrás.")).toBeVisible();

  await page.getByLabel("Tu clave actual", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Aceptar invitación" }).click();
  const code = page.getByLabel("Código de verificación", { exact: true });
  await expect(code).toBeFocused();
  await code.fill(TOTP_CODE);
  await page.getByRole("button", { name: "Aceptar invitación" }).click();

  // Entra al negocio que la invitó y ahora puede cambiar entre los dos.
  await expect(heading(page, "Inicio")).toBeVisible();
  await page.getByRole("button", { name: /Cambiar de negocio/ }).click();
  await expect(page.getByRole("menuitem", { name: /Estética Aurora/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Clínica Dental Sonrisa/ })).toBeVisible();
});

test("móvil (375 px): barra inferior con Más y sin scroll horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, "duena@demo.test");
  await expect(heading(page, "Inicio")).toBeVisible();

  const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await noHorizontalScroll()).toBe(true);

  const nav = page.getByRole("navigation", { name: "Principal" });
  await expect(nav.getByRole("link", { name: "Agenda" })).toBeVisible();
  await nav.getByRole("button", { name: "Más" }).click();
  const sheet = page.getByRole("dialog", { name: "Más secciones" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("link", { name: "Configuración" }).click();
  await expect(sheet).toBeHidden();
  await expect(heading(page, "Configuración")).toBeVisible();
  expect(await noHorizontalScroll()).toBe(true);

  // Con la sesión abierta, /login vuelve al panel.
  await page.goto("/panel/login");
  await expect(heading(page, "Inicio")).toBeVisible();
});

test("superadmin: login con 2FA, lista de negocios y alta de uno nuevo", async ({ page }) => {
  await page.goto("/panel/admin");
  await expect(page).toHaveURL(/\/panel\/admin\/login$/);
  await page.getByLabel("Usuario", { exact: true }).fill("admin");
  await page.getByLabel("Clave", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByLabel("Código", { exact: true }).fill(TOTP_CODE);
  await page.getByRole("button", { name: "Verificar y entrar" }).click();

  await expect(heading(page, "Negocios")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Clínica Dental Sonrisa" })).toContainText("2 sucursales");

  await page.getByRole("button", { name: "Crear negocio" }).click();
  await expect(page.getByText("Escribí el nombre del negocio.")).toBeVisible();

  await page.getByLabel("Nombre del negocio").fill("Spa Las Palmas");
  await page.getByLabel("Rubro").selectOption("aesthetics");
  await page.getByLabel("País").selectOption("PA");
  await expect(page.getByLabel("Moneda")).toHaveValue("USD");
  await page.getByLabel("Primera sucursal").fill("Centro");
  await page.getByLabel("Nombre del dueño").fill("Laura Méndez");
  await page.getByLabel("Correo del dueño").fill("laura@spa.test");
  await page.getByRole("button", { name: "Crear negocio" }).click();
  await expect(page.getByText("Negocio «Spa Las Palmas» creado.")).toBeVisible();
  const created = page.getByRole("listitem").filter({ hasText: "Spa Las Palmas" });
  await expect(created).toContainText("spa-las-palmas");
  await expect(created).toContainText("PA · USD");
  await expect(created).toContainText("1 sucursal");
});
