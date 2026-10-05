import { test, expect, type Page } from "@playwright/test";
import { TENANTS, USUARIOS } from "./constantes";
import {
  apiComo,
  entrar,
  enviados,
  esperarToast,
  graphFalla,
  hoyCR,
  responderDialogo,
  sumarDias,
  vigilarConsola,
  webhookTexto,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Bandeja (Inbox): filtros, búsqueda, chat, modo bot/humano, atendida, acciones
// rápidas, ventana de 24h, permiso de promociones, ficha del cliente (notas, historial,
// borrado Ley 8968) y mensajes entrantes en vivo por el webhook firmado.
// Cada test que MUTA usa su propio cliente (número nuevo por webhook) para no pisarse.
// ─────────────────────────────────────────────────────────────────────────────

const PNID = TENANTS.clinica.pnid;
let seqCliente = 0;
/** Número de cliente nuevo y único por test (la conversación nace por el webhook). */
function clienteNuevo(): string {
  return `5067${String(Date.now()).slice(-5)}${String(++seqCliente).padStart(2, "0")}`;
}

async function abrirPorBusqueda(page: Page, q: string) {
  await page.locator(".buscador input").fill(q);
  const conv = page.locator("#convs .conv").first();
  await expect(conv).toBeVisible({ timeout: 15_000 });
  await conv.click();
  await expect(page.locator("#chatTitulo")).toBeVisible();
}

/** Crea la conversación de un cliente nuevo por el webhook y espera la respuesta del bot. */
async function conversacionNueva(page: Page, texto = "Hola, quisiera información"): Promise<string> {
  const wa = clienteNuevo();
  await webhookTexto(page.request, { pnid: PNID, clienteWa: wa, texto });
  await expect
    .poll(async () => (await enviados(page.request)).some((e) => e.to === wa && e.texto?.includes("Respuesta automática")), {
      timeout: 30_000, // holgura para máquinas cargadas (el bot normalmente responde en <1 s)
    })
    .toBe(true);
  return wa;
}

test("filtros de la bandeja: cada pill filtra y su contador coincide con la lista", async ({ page }) => {
  const errores = vigilarConsola(page);
  await entrar(page, USUARIOS.clinica);
  await expect(page.locator("#convs .conv").first()).toBeVisible();
  for (const nombre of ["Todos", "Bot", "Vos", "Necesita respuesta", "Atendidas"]) {
    const pill = page.locator(".filtro-pill", { hasText: nombre });
    await pill.click();
    await expect(pill).toHaveClass(/activo/);
    const esperado = Number(await pill.locator(".filtro-count").textContent());
    if (esperado === 0) {
      await expect(page.locator("#convs .conv")).toHaveCount(0);
      await expect(page.getByText("Sin resultados para este filtro")).toBeVisible();
    } else {
      await expect(page.locator("#convs .conv")).toHaveCount(esperado);
    }
    if (nombre === "Bot") for (const p of await page.locator("#convs .conv .pill").allTextContents()) expect(p).toBe("bot");
    if (nombre === "Vos") for (const p of await page.locator("#convs .conv .pill").allTextContents()) expect(p).toBe("vos");
    if (nombre === "Necesita respuesta" && esperado > 0) await expect(page.locator("#convs .conv.necesita").first()).toBeVisible();
  }
  expect(errores, errores.join("\n")).toEqual([]);
});

test("búsqueda por número y por texto del último mensaje; sin resultados → 'Ver todos' limpia", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  const buscador = page.locator(".buscador input");
  await buscador.fill("50687123344");
  await expect(page.locator("#convs .conv")).toHaveCount(1);
  await expect(page.locator("#convs .conv .num")).toHaveText("Diego Ramírez");

  await buscador.fill("radiograf");
  await expect(page.locator("#convs .conv").first()).toBeVisible();

  await buscador.fill("zzz-no-existe-zzz");
  await expect(page.locator("#convs .conv")).toHaveCount(0);
  await page.getByRole("button", { name: "Ver todos" }).click();
  await expect(buscador).toHaveValue("");
  await expect(page.locator(".filtro-pill.activo")).toContainText("Todos");
  expect(await page.locator("#convs .conv").count()).toBeGreaterThan(5);
});

test("chat vacío: 'Ver la que necesita respuesta' abre la conversación pendiente", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  await expect(page.getByText("Elegí una conversación")).toBeVisible();
  const cta = page.getByRole("button", { name: "Ver la que necesita respuesta" });
  await expect(cta).toBeVisible();
  await cta.click();
  await expect(page.locator(".chatHead .pill-estado.humano")).toBeVisible();
  await expect(page.locator("#convs .conv.activa")).toHaveClass(/necesita|activa/);
});

test("mensaje entrante por el webhook aparece en la bandeja sin recargar y el bot responde", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  const antes = await page.locator("#convs .conv").count();
  const wa = clienteNuevo();
  await webhookTexto(page.request, { pnid: PNID, clienteWa: wa, texto: "Mensaje en vivo E2E" });
  // El polling (4 s) trae la conversación nueva.
  await expect(page.locator("#convs .conv")).toHaveCount(antes + 1, { timeout: 15_000 });
  await abrirPorBusqueda(page, wa);
  await expect(page.locator("#msgs .b.cliente").last()).toContainText("Mensaje en vivo E2E");
  await expect(page.locator("#msgs .b.bot").last()).toContainText("Respuesta automática del bot", { timeout: 15_000 });
  await expect(page.locator(".pill-ventana.abierta")).toContainText("cierra en");
});

test("Atender yo ↔ Devolver al bot cambia el modo y el pill del encabezado", async ({ page }) => {
  const wa = await conversacionNueva(page);
  await entrar(page, USUARIOS.clinica);
  await abrirPorBusqueda(page, wa);
  await expect(page.locator(".chatHead .pill-estado.bot")).toContainText("Lo atiende el bot");
  await page.getByRole("button", { name: "Atender yo" }).click();
  await expect(page.locator(".chatHead .pill-estado.humano")).toContainText("Lo atendés vos");
  await expect(page.locator("#convs .conv.activa .pill")).toHaveText("vos", { timeout: 10_000 });
  await page.getByRole("button", { name: "Devolver al bot" }).click();
  await expect(page.locator(".chatHead .pill-estado.bot")).toBeVisible();
});

test("Atendido ↔ Reabrir con toast y aparece en el filtro 'Atendidas'", async ({ page }) => {
  const wa = await conversacionNueva(page);
  await entrar(page, USUARIOS.clinica);
  await abrirPorBusqueda(page, wa);
  await page.getByRole("button", { name: "Atendido" }).click();
  await esperarToast(page, "Conversación marcada como atendida ✓");
  await expect(page.getByRole("button", { name: "Reabrir" })).toBeVisible();
  await page.locator(".filtro-pill", { hasText: "Atendidas" }).click();
  await expect(page.locator("#convs .conv")).toHaveCount(1);
  await page.getByRole("button", { name: "Reabrir" }).click();
  await esperarToast(page, "Conversación reabierta");
  await expect(page.locator("#convs .conv")).toHaveCount(0);
});

test("acciones rápidas en modo bot piden confirmación; cancelar no envía nada", async ({ page }) => {
  const wa = await conversacionNueva(page);
  await entrar(page, USUARIOS.clinica);
  await abrirPorBusqueda(page, wa);
  const antes = (await enviados(page.request)).filter((e) => e.to === wa).length;

  const dlg = responderDialogo(page, false);
  await page.getByRole("button", { name: "Agendar cita" }).click();
  expect(await dlg).toContain("modo humano");
  await page.waitForTimeout(500);
  expect((await enviados(page.request)).filter((e) => e.to === wa).length).toBe(antes);
  await expect(page.locator(".chatHead .pill-estado.bot")).toBeVisible();

  // Aceptar: envía el texto de cita, pasa a humano y muestra el toast.
  const ok = responderDialogo(page, true);
  await page.getByRole("button", { name: "Agendar cita" }).click();
  await ok;
  await esperarToast(page, "Mensaje de cita enviado");
  await expect(page.locator("#msgs .b.humano").last()).toContainText("Podemos agendar tu cita");
  await expect(page.locator(".chatHead .pill-estado.humano")).toBeVisible();

  // Ya en humano, "Cotización" NO pide confirmación.
  let huboDialogo = false;
  page.once("dialog", (d) => {
    huboDialogo = true;
    void d.dismiss();
  });
  await page.getByRole("button", { name: "Cotización" }).click();
  await esperarToast(page, "Mensaje de cotización enviado");
  expect(huboDialogo).toBe(false);
  const textos = (await enviados(page.request)).filter((e) => e.to === wa).map((e) => e.texto ?? "");
  expect(textos.some((t) => t.includes("cotización"))).toBe(true);
});

test("composer: Enter envía, Shift+Enter hace salto de línea, vacío no envía", async ({ page }) => {
  const wa = await conversacionNueva(page);
  await entrar(page, USUARIOS.clinica);
  await abrirPorBusqueda(page, wa);
  const ta = page.locator("#composer textarea");

  await ta.fill("   ");
  await ta.press("Enter");
  await page.waitForTimeout(400);
  expect((await enviados(page.request)).filter((e) => e.to === wa && e.texto?.trim() === "").length).toBe(0);

  await ta.fill("Línea 1");
  await ta.press("Shift+Enter");
  await ta.type("Línea 2");
  await expect(ta).toHaveValue("Línea 1\nLínea 2");
  await ta.press("Enter");
  await expect(ta).toHaveValue("");
  await expect(page.locator("#msgs .b.humano").last()).toContainText("Línea 1");
  const ult = (await enviados(page.request)).filter((e) => e.to === wa).at(-1);
  expect(ult?.texto).toBe("Línea 1\nLínea 2");

  // Botón enviar (avión).
  await ta.fill("Por botón");
  await page.getByRole("button", { name: "Enviar mensaje" }).click();
  await expect(page.locator("#msgs .b.humano").last()).toContainText("Por botón");
});

test("si Graph falla al responder: toast de error y el mensaje NO queda en el chat", async ({ page }) => {
  const wa = await conversacionNueva(page);
  await entrar(page, USUARIOS.clinica);
  await abrirPorBusqueda(page, wa);
  await graphFalla(page.request, true);
  try {
    await page.locator("#composer textarea").fill("Esto va a fallar");
    await page.locator("#composer textarea").press("Enter");
    await esperarToast(page, "No se pudo enviar el mensaje");
    await expect(page.locator("#composer textarea")).toHaveValue("Esto va a fallar"); // el borrador se conserva
    await expect(page.locator("#msgs")).not.toContainText("Esto va a fallar");
  } finally {
    await graphFalla(page.request, false);
  }
});

test("el borrador NO se arrastra al cambiar de conversación", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  await page.locator("#convs .conv").nth(0).click();
  await page.locator("#composer textarea, #composer").first().waitFor();
  const ta = page.locator("#composer textarea");
  if (await ta.count()) await ta.fill("borrador a medias");
  await page.locator("#convs .conv").nth(1).click();
  const ta2 = page.locator("#composer textarea");
  if (await ta2.count()) await expect(ta2).toHaveValue("");
});

test("ventana de 24h cerrada: composer bloqueado; con plantilla de reapertura aparece 'Reabrir conversación'", async ({ page, playwright }) => {
  const api = await apiComo(playwright, USUARIOS.clinica);
  await entrar(page, USUARIOS.clinica);
  await abrirPorBusqueda(page, "50661334477"); // Fernando Ulate: último mensaje hace ~34 h
  await expect(page.locator(".pill-ventana.cerrada")).toHaveText("🔴 ventana cerrada");
  await expect(page.locator("#composer.composer-cerrado")).toContainText("Ventana de 24h cerrada");
  await expect(page.locator("#composer textarea")).toHaveCount(0);
  await expect(page.getByText('Configurá la plantilla de reapertura en "Mi negocio"')).toBeVisible();
  // Responder por la API fuera de ventana → 409 ventana_cerrada (no se intenta enviar).
  const conv = (await (await page.request.get("/api/panel/conversaciones")).json()).conversaciones.find(
    (c: { clienteWa: string }) => c.clienteWa === "50661334477",
  );
  const r = await api.post(`/api/panel/conversaciones/${conv.id}/responder`, { data: { texto: "hola" } });
  expect(r.status()).toBe(409);

  // Configurar la plantilla (Mi negocio) y volver: aparece el botón y manda la plantilla.
  const cfg = await (await api.get("/api/panel/config")).json();
  const guardar = await api.post("/api/panel/config", { data: { ...cfg, plantillaReapertura: "reapertura_e2e" } });
  expect(guardar.status(), await guardar.text()).toBe(200);
  try {
    await page.reload();
    await abrirPorBusqueda(page, "50661334477");
    await page.getByRole("button", { name: "Reabrir conversación" }).click();
    await esperarToast(page, "Plantilla de reapertura enviada");
    await expect(page.locator("#msgs")).toContainText("Plantilla de reapertura enviada");
    const plantilla = (await enviados(page.request)).filter((e) => e.to === "50661334477" && e.tipo === "template").at(-1);
    expect(plantilla?.plantilla).toBe("reapertura_e2e");
  } finally {
    await api.post("/api/panel/config", { data: { ...cfg, plantillaReapertura: cfg.plantillaReapertura } });
  }
});

test("pedir permiso de promociones (Pro): confirma, envía botones Sí/No y no deja re-preguntar", async ({ page }) => {
  const wa = await conversacionNueva(page);
  await entrar(page, USUARIOS.clinica);
  await abrirPorBusqueda(page, wa);
  const boton = page.getByRole("button", { name: "Pedir permiso promos" });

  const cancelar = responderDialogo(page, false);
  await boton.click();
  expect(await cancelar).toContain("promociones");

  const aceptar = responderDialogo(page, true);
  await boton.click();
  await aceptar;
  await esperarToast(page, "Le preguntamos si quiere recibir promociones");
  const interactivo = (await enviados(page.request)).filter((e) => e.to === wa && e.tipo === "interactive").at(-1);
  const botones = interactivo?.raw?.interactive?.action?.buttons?.map((b: { reply: { id: string } }) => b.reply.id);
  expect(botones).toEqual(["mktsi", "mktno"]);

  const otra = responderDialogo(page, true);
  await boton.click();
  await otra;
  await esperarToast(page, /Ya se le preguntó hace poco/);

  // El cliente toca "Sí" → queda con consentimiento (lo cuenta Campañas).
  const antes = await (await page.request.get("/api/panel/campanias/consentimiento")).json();
  await webhookTexto(page.request, { pnid: PNID, clienteWa: wa, interactiveId: "mktsi", titulo: "Sí, quiero" });
  await expect
    .poll(async () => (await (await page.request.get("/api/panel/campanias/consentimiento")).json()).conConsentimiento, { timeout: 15_000 })
    .toBe(antes.conConsentimiento + 1);
});

test("ficha del cliente: datos, historial con estados, 'Cliente frecuente', notas persistentes; cerrar con ✕ y con el fondo", async ({ page, playwright }) => {
  const wa = await conversacionNueva(page);
  const api = await apiComo(playwright, USUARIOS.clinica);
  // 3 citas → "Cliente frecuente"; una completada y otra cancelada para ver los badges.
  const fechas = [sumarDias(hoyCR(), 40), sumarDias(hoyCR(), 41), sumarDias(hoyCR(), 42)];
  const ids: string[] = [];
  for (const [i, fecha] of fechas.entries()) {
    const r = await api.post("/api/panel/citas", {
      data: { clienteNombre: "Cliente Ficha E2E", clienteWa: wa, servicioId: "valoracion", fecha, hora: "10:00", placa: i === 0 ? "EXP-123" : undefined },
    });
    expect(r.status(), await r.text()).toBe(200);
    ids.push((await r.json()).cita.id);
  }
  await api.post(`/api/panel/citas/${ids[1]}/completar`);
  await api.post(`/api/panel/citas/${ids[2]}/cancelar`);

  await entrar(page, USUARIOS.clinica);
  await abrirPorBusqueda(page, wa);
  await page.locator(".chatHead").click();
  const modal = page.locator(".ficha-modal-cliente");
  await expect(modal).toBeVisible();
  await expect(modal.locator(".pill-frecuente")).toContainText("Cliente frecuente");
  await expect(modal.locator(".ficha-tile", { hasText: "Total de citas" }).locator("b")).toHaveText("3");
  await expect(modal.locator(".ficha-tile", { hasText: "Referencia" }).locator("b")).toContainText("EXP-123");
  await expect(modal.locator(".ficha-historial-item")).toHaveCount(3);
  await expect(modal.locator(".ficha-historial-servicio").first()).toHaveText("Valoración");
  await expect(modal.locator(".badge-estado", { hasText: "Completada" })).toBeVisible();
  await expect(modal.locator(".badge-estado", { hasText: "Cancelada" })).toBeVisible();

  await modal.locator(".ficha-notas-input").first().fill("Prefiere las mañanas (E2E)");
  await modal.getByRole("button", { name: "Guardar notas" }).click();
  await expect(modal.getByRole("button", { name: "Guardado" })).toBeVisible();
  await modal.locator(".ficha-head button").click(); // ✕
  await expect(modal).toHaveCount(0);

  await page.reload();
  await abrirPorBusqueda(page, wa);
  await page.locator(".chatHead").click();
  await expect(page.locator(".ficha-modal-cliente .ficha-notas-input").first()).toHaveValue("Prefiere las mañanas (E2E)");
  // Cerrar tocando el fondo (overlay).
  await page.locator(".overlay").click({ position: { x: 5, y: 5 } });
  await expect(page.locator(".ficha-modal-cliente")).toHaveCount(0);
});

test("borrar datos del cliente (dueño): confirmación fuerte, cancelar, borrado real y la conversación desaparece", async ({ page }) => {
  const wa = await conversacionNueva(page);
  await entrar(page, USUARIOS.clinica);
  await abrirPorBusqueda(page, wa);
  await page.locator(".chatHead").click();
  const modal = page.locator(".ficha-modal-cliente");
  await modal.getByRole("button", { name: "Borrar todos los datos de este cliente…" }).click();
  const borrar = modal.getByRole("button", { name: "Borrar definitivamente" });
  await expect(borrar).toBeDisabled();
  await modal.locator("#borrarConfirmacion").fill("50600000000");
  await expect(borrar).toBeDisabled();
  await modal.getByRole("button", { name: "Cancelar" }).click();
  await expect(borrar).toHaveCount(0);

  await modal.getByRole("button", { name: "Borrar todos los datos de este cliente…" }).click();
  await modal.locator("#borrarConfirmacion").fill(`+${wa}`); // con "+" y formato: se normaliza
  await expect(borrar).toBeEnabled();
  await borrar.click();
  await expect(modal.getByText("Datos del cliente borrados")).toBeVisible();
  await modal.getByRole("button", { name: "Listo" }).click();
  await expect(page.locator("#app")).toBeVisible();
  await page.locator(".buscador input").fill(wa);
  await expect(page.locator("#convs .conv")).toHaveCount(0);
  const convs = (await (await page.request.get("/api/panel/conversaciones")).json()).conversaciones;
  expect(convs.some((c: { clienteWa: string }) => c.clienteWa === wa)).toBe(false);
});

test("operador: no ve la zona de borrado ni las pestañas de dueño; la API de borrado le da 403", async ({ page, playwright }) => {
  const wa = await conversacionNueva(page);
  await entrar(page, USUARIOS.clinicaOp);
  await expect(page.locator(".hd-tab", { hasText: "Mi negocio" })).toHaveCount(0);
  await expect(page.locator(".hd-tab", { hasText: "Usuarios" })).toHaveCount(0);
  await expect(page.locator(".hd-tab", { hasText: "Campañas" })).toHaveCount(0);
  await abrirPorBusqueda(page, wa);
  await page.locator(".chatHead").click();
  await expect(page.locator(".ficha-modal-cliente")).toBeVisible();
  await expect(page.getByText("Borrar datos del cliente")).toHaveCount(0);
  const api = await apiComo(playwright, USUARIOS.clinicaOp);
  const conv = (await (await api.get("/api/panel/conversaciones")).json()).conversaciones.find(
    (c: { clienteWa: string }) => c.clienteWa === wa,
  );
  const r = await api.post(`/api/panel/conversaciones/${conv.id}/borrar-cliente`, { data: { confirmar: wa } });
  expect(r.status()).toBe(403);
});

test("móvil: abrir chat oculta la lista y 'Volver' regresa", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await entrar(page, USUARIOS.clinica);
  await page.locator("#convs .conv").first().click();
  await expect(page.locator("#lista")).toHaveClass(/escondida/);
  await expect(page.locator("#chat")).not.toHaveClass(/escondido/);
  await page.getByRole("button", { name: "Volver a la lista" }).click();
  await expect(page.locator("#lista")).not.toHaveClass(/escondida/);
  await expect(page.locator("#chat")).toHaveClass(/escondido/);
});

test("aislamiento: otro negocio no ve las conversaciones de la clínica (ni por id)", async ({ playwright }) => {
  const clinica = await apiComo(playwright, USUARIOS.clinica);
  const convs = (await (await clinica.get("/api/panel/conversaciones")).json()).conversaciones;
  const basico = await apiComo(playwright, USUARIOS.basico);
  const otras = (await (await basico.get("/api/panel/conversaciones")).json()).conversaciones;
  expect(otras.some((c: { id: string }) => convs.some((x: { id: string }) => x.id === c.id))).toBe(false);
  const r = await basico.get(`/api/panel/conversaciones/${convs[0].id}`);
  expect(r.status()).toBe(404);
  const r2 = await basico.post(`/api/panel/conversaciones/${convs[0].id}/modo`, { data: { modo: "humano" } });
  expect(r2.status()).toBe(404);
});
