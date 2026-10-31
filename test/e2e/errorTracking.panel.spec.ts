import { expect, test, type Page, type Request } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// Error boundary de la raíz del panel + reporte a Sentry (web/src/app/AppErrorBoundary.tsx
// y web/src/lib/errorTracking.ts), contra la API simulada (proyecto "panel-mock").
//
// Para forzar un error de render sin dejar un "botón de romper" en el código, el test
// reemplaza en el navegador el módulo de la página 404 (Vite en desarrollo sirve cada
// módulo por separado) por uno que lanza al renderizarse. El DSN lo agrega el test al
// index como `<meta name="sentry-dsn">` —igual que hace el server en producción
// (src/platform/http/staticPanel.ts)— y el envío a Sentry se intercepta: nada sale a la red.
// ─────────────────────────────────────────────────────────────────────────────

const SENTRY_HOST = "https://o0.ingest.sentry.e2e.invalid";
const DSN = "https://e2epublickey@o0.ingest.sentry.e2e.invalid/1";
const CRASH = "Prueba E2E: falla de render en la página 404";

/** Reemplaza el módulo de la 404 por uno que lanza en el render. */
async function breakNotFoundPage(page: Page) {
  await page.route(/\/src\/app\/NotFoundPage\.tsx(\?.*)?$/, (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `export default function NotFoundPage() { throw new Error(${JSON.stringify(CRASH)}); }`,
    }),
  );
}

/** Index del panel con la meta del DSN (como lo sirve el server con SENTRY_DSN). */
async function injectSentryDsn(page: Page) {
  await page.route(
    (url) => url.pathname === "/panel" || url.pathname.startsWith("/panel/"),
    async (route) => {
      if (route.request().resourceType() !== "document") return route.fallback();
      const response = await route.fetch();
      const html = (await response.text()).replace(
        "</head>",
        `<meta name="sentry-dsn" content="${DSN}"><meta name="sentry-environment" content="e2e"><meta name="sentry-release" content="e2e-sha"></head>`,
      );
      await route.fulfill({ response, body: html });
    },
  );
}

/** Captura lo que el SDK manda a Sentry (y le responde OK sin salir a la red). */
async function captureSentry(page: Page): Promise<string[]> {
  const bodies: string[] = [];
  await page.route(`${SENTRY_HOST}/**`, (route) => {
    bodies.push(route.request().postData() ?? "");
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "{}" });
  });
  return bodies;
}

async function login(page: Page) {
  await page.goto("/panel/login");
  await page.getByLabel("Correo", { exact: true }).fill("duena@demo.test");
  await page.getByLabel("Clave", { exact: true }).fill("demo1234");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Inicio", exact: true })).toBeVisible();
}

/** Cuerpos de envelope con un evento de error (no sesiones). */
const errorEvents = (bodies: string[]) => bodies.filter((b) => b.includes('"type":"event"'));

test("un error de render muestra «Algo salió mal» y genera UN reporte a Sentry con release, tag panel y sin query", async ({ page }) => {
  const bodies = await captureSentry(page);
  await injectSentryDsn(page);
  await breakNotFoundPage(page);
  await login(page);

  await page.goto("/panel/ruta-que-no-existe?token=secreto-de-prueba");
  await expect(page.getByRole("heading", { level: 1, name: "Algo salió mal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Recargar la página" })).toBeVisible();

  await expect.poll(() => errorEvents(bodies).length, { message: "el reporte llegó a Sentry" }).toBeGreaterThanOrEqual(1);
  // Un poco de margen por si llegara un duplicado (window.onerror además del boundary).
  await page.waitForTimeout(500);
  const events = errorEvents(bodies);
  expect(events).toHaveLength(1);
  const [event] = events;
  expect(event).toContain(CRASH);
  expect(event).toContain('"app":"panel"');
  expect(event).toContain('"release":"e2e-sha"');
  expect(event).toContain('"environment":"e2e"');
  expect(event).not.toContain("secreto-de-prueba");
  expect(event).not.toContain("duena@demo.test");
});

test("sin DSN: la pantalla de error aparece igual y no se manda nada a Sentry", async ({ page }) => {
  const sentry: Request[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).hostname.includes("sentry")) sentry.push(req);
  });
  await breakNotFoundPage(page);
  await login(page);

  await page.goto("/panel/otra-ruta-que-no-existe");
  await expect(page.getByRole("heading", { level: 1, name: "Algo salió mal" })).toBeVisible();
  await page.waitForTimeout(500);
  expect(sentry).toHaveLength(0);
});
