import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { USUARIOS } from "./constantes";
import { apiComo, entrar, esperarToast, vigilarConsola } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// "Mi negocio" (C2.2): sub-nav, barra de guardado (sucio/descartar), CADA sección
// editada por la UI y verificada tras recargar, validaciones del backend, white-label
// aplicado al panel, historial versionado (F15) y el gating de plan Básico.
// Se restaura la config original de la clínica al final.
// ─────────────────────────────────────────────────────────────────────────────

let api: APIRequestContext;
let original: Record<string, unknown>;

test.beforeAll(async ({ playwright }) => {
  api = await apiComo(playwright, USUARIOS.clinica);
  original = await (await api.get("/api/panel/config")).json();
});
test.afterAll(async () => {
  const r = await api.post("/api/panel/config", { data: original });
  expect(r.status(), await r.text()).toBe(200);
});

async function abrirMiNegocio(page: Page) {
  await page.locator(".hd-tab", { hasText: "Mi negocio" }).click();
  await expect(page.locator("#miNegocio .mn-layout")).toBeVisible();
}

const barra = (page: Page) => page.locator(".mn-guardar-barra");
async function guardar(page: Page) {
  await barra(page).getByRole("button", { name: "Guardar cambios" }).click();
  await esperarToast(page, "Configuración guardada");
  await expect(barra(page)).toContainText("Todo guardado");
}


test("sub-nav: cada ítem salta a su sección y queda activo", async ({ page }) => {
  const errores = vigilarConsola(page);
  await entrar(page, USUARIOS.clinica);
  await abrirMiNegocio(page);
  const items = page.locator(".mn-subnav-item");
  await expect(items).toHaveCount(14);
  const ids = ["mnPerfil", "mnMarca", "mnServicios", "mnEquipo", "mnHorario", "mnFeriados", "mnCalendario", "mnResenas", "mnVentana24", "mnRecordatorios", "mnCampanias", "mnRescate", "mnBaseConocimiento", "mnFaq"];
  for (const [i, id] of ids.entries()) {
    await items.nth(i).click();
    await expect(items.nth(i)).toHaveClass(/activo/);
    await expect(page.locator(`#${id}`)).toBeInViewport({ ratio: 0.05 });
  }
  expect(errores, errores.join("\n")).toEqual([]);
});

test("barra de guardado: detecta cambios, Descartar revierte, y sin cambios queda 'Todo guardado'", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  await abrirMiNegocio(page);
  await expect(barra(page)).toContainText("Todo guardado");
  const descartar = barra(page).getByRole("button", { name: "Descartar" });
  await expect(descartar).toBeDisabled();
  const valorOriginal = await page.locator("#cTono").inputValue();
  await page.locator("#cTono").fill("tono temporal E2E");
  await expect(barra(page)).toContainText("Cambios sin guardar");
  await expect(descartar).toBeEnabled();
  await descartar.click();
  await esperarToast(page, "Cambios descartados");
  await expect(page.locator("#cTono")).toHaveValue(valorOriginal);
  await expect(barra(page)).toContainText("Todo guardado");
  // Volver al valor original a mano también limpia el "sucio".
  await page.locator("#cTono").fill("x");
  await page.locator("#cTono").fill(valorOriginal);
  await expect(barra(page)).toContainText("Todo guardado");
});

test("perfil, calendario, reseñas, plantillas y rescate: se guardan y persisten tras recargar", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  await abrirMiNegocio(page);
  const campos: [string, string][] = [
    ["#cTipoNegocio", "una clínica dental de prueba"],
    ["#cPais", "Costa Rica"],
    ["#cTono", "amable y breve (E2E)"],
    ["#cFormasPago", "SINPE y tarjeta (E2E)"],
    ["#cInstrucciones", "- Regla uno E2E\n- Regla dos E2E"],
    ["#cGoogleCalendarId", "clinica-e2e@gmail.com"],
    ["#cLinkResenas", "https://g.page/r/e2e-resenas"],
    ["#cGooglePlaceId", "ChIJN1t_tDeuEmsRUsoyG83frY4"],
    ["#cPlantillaReapertura", "reapertura_e2e"],
    ["#cPlantillaRecordatorio", "recordatorio_e2e"],
    ["#cPlantillaIdioma", "es_MX"],
    ["#cPlantillaMkt", "promo_e2e"],
    ["#cRescateHoras", "5"],
    ["#cRescateToque1", "¿Te guardo el {servicio}? (E2E)"],
    ["#cRescateToque2", "variable E2E"],
    ["#cRescatePlantilla", "rescate_e2e"],
  ];
  for (const [sel, valor] of campos) await page.locator(sel).fill(valor);
  await page.locator("#cRegistro").selectOption("usted");
  const rescate = page.locator("#mnRescate .switch input");
  if (!(await rescate.isChecked())) await page.locator("#mnRescate .switch").click();
  await expect(rescate).toBeChecked();
  await expect(barra(page)).toContainText("Cambios sin guardar");
  await guardar(page);

  await page.reload();
  await abrirMiNegocio(page);
  for (const [sel, valor] of campos) await expect(page.locator(sel), sel).toHaveValue(valor);
  await expect(page.locator("#cRegistro")).toHaveValue("usted");
  await expect(page.locator("#mnRescate .switch input")).toBeChecked();
  // La plantilla de reapertura habilita el botón del chat (/me → reaperturaConfigurada).
  const me = await (await page.request.get("/api/panel/me")).json();
  expect(me.reaperturaConfigurada).toBe(true);
});

test("marca (white-label Pro): logo y colores se aplican al panel; 'Restaurar colores' vuelve al default", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  await abrirMiNegocio(page);
  await page.locator("#cLogoUrl").fill("https://placehold.co/64x64.png");
  await page.locator("#cColorAcento").fill("#aa2233");
  await page.locator("#cColorHeader").fill("#112233");
  await guardar(page);
  const raiz = page.locator("html");
  await expect.poll(() => raiz.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--brand-accent"))).toBe("#aa2233");
  await expect.poll(() => raiz.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--brand-header-bg"))).toBe("#112233");
  await expect(page.locator("#appHeader img.marca-logo")).toHaveAttribute("src", "https://placehold.co/64x64.png");

  await page.getByRole("button", { name: "Restaurar colores por defecto" }).click();
  await page.locator("#cLogoUrl").fill("");
  await guardar(page);
  await expect.poll(() => raiz.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--brand-accent"))).toBe("");
  await expect(page.locator("#appHeader img.marca-logo")).toHaveCount(0);
  await expect(page.locator("#appHeader .marca-chip")).toHaveText("CD");

  // Logout limpia la marca (no se filtra a la próxima sesión).
  await page.locator("#cColorAcento").fill("#00aa00");
  await guardar(page);
  await page.getByRole("button", { name: "Salir" }).click();
  await expect(page.locator("#login")).toBeVisible();
  await expect.poll(() => raiz.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--brand-accent"))).toBe("");
});

test("servicios: nuevo, editar, precio variable, agendable, add-on, reordenar (arrastrar) y quitar", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  await abrirMiNegocio(page);
  const items = page.locator(".svc-item");
  const n = await items.count();
  await page.getByRole("button", { name: "Nuevo servicio" }).click();
  await expect(items).toHaveCount(n + 1);
  const nuevo = items.nth(n);
  await nuevo.locator(".svc-nombre-input").fill("Ortodoncia E2E Ñandú");
  await expect(nuevo.locator(`#svcNombre${n}`)).toHaveValue("Ortodoncia E2E Ñandú"); // los dos inputs de nombre van sincronizados
  await nuevo.locator(`#svcPrecio${n}`).fill("50000");
  await nuevo.locator(`#svcDuracion${n}`).fill("75");
  await nuevo.locator(`#svcNota${n}`).fill("según valoración");
  // Precio variable deshabilita el precio base.
  await nuevo.locator(".svc-switch-row", { hasText: "Precio variable" }).click();
  await expect(nuevo.locator(`#svcPrecio${n}`)).toBeDisabled();
  await nuevo.locator(".svc-switch-row", { hasText: "Precio variable" }).click();
  await expect(nuevo.locator(`#svcPrecio${n}`)).toBeEnabled();
  // Agendable (viene encendido) muestra el pill; apagarlo lo quita.
  await expect(nuevo.locator(".svc-pill-agendable")).toBeVisible();
  // Add-on: activar y elegir "Aplicación de flúor" con precio promo.
  await nuevo.locator(".svc-switch-row", { hasText: "Ofrecer add-on" }).click();
  await nuevo.locator(`#svcAddon${n}`).selectOption({ label: "Aplicación de flúor" });
  await nuevo.locator(`#svcAddonPrecio${n}`).fill("5000");
  await guardar(page);

  await page.reload();
  await abrirMiNegocio(page);
  const guardado = page.locator(".svc-item", { has: page.locator('.svc-nombre-input[value="Ortodoncia E2E Ñandú"]') });
  await expect(guardado).toHaveCount(1);
  await expect(guardado.locator(".svc-slug-input")).toHaveValue("ortodoncia-e2e-nandu"); // slug derivado del nombre
  const cfg = await (await api.get("/api/panel/config")).json();
  const s = cfg.servicios.find((x: { id: string }) => x.id === "ortodoncia-e2e-nandu");
  expect(s).toMatchObject({ precio: 50000, duracionMin: 75, agendable: true, addonSugeridoId: "fluor", addonPrecioPromo: 5000, addonActivo: true, precioNota: "según valoración" });

  // Reordenar arrastrando (desde el grip: el centro de la tarjeta es un input y ahí no
  // arranca un arrastre). Cada tarjeta mide ~450 px: con un viewport alto origen y destino
  // quedan visibles a la vez (la emulación de arrastre no hace auto-scroll).
  await page.setViewportSize({ width: 1280, height: 2200 });
  await page.locator("#mnServicios").scrollIntoViewIfNeeded();
  const nombresAntes = await page.locator(".svc-nombre-input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  await page.locator(".svc-item").nth(1).locator(".svc-grip").dragTo(page.locator(".svc-item").nth(0).locator(".svc-grip"));
  const nombresDespues = await page.locator(".svc-nombre-input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  expect(nombresDespues.slice(0, 2)).toEqual([nombresAntes[1], nombresAntes[0]]);
  await expect(barra(page)).toContainText("Cambios sin guardar");
  await barra(page).getByRole("button", { name: "Descartar" }).click();

  // Quitar el servicio nuevo.
  await page
    .locator(".svc-item", { has: page.locator('.svc-nombre-input[value="Ortodoncia E2E Ñandú"]') })
    .getByTitle("Quitar servicio")
    .click();
  await guardar(page);
  const cfg2 = await (await api.get("/api/panel/config")).json();
  expect(cfg2.servicios.some((x: { id: string }) => x.id === "ortodoncia-e2e-nandu")).toBe(false);
});

test("equipo, horario y feriados: agregar/quitar filas y persistir", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  await abrirMiNegocio(page);
  // Equipo vacío → CTA "Agregar al primero".
  await page.locator("#mnEquipo").getByRole("button", { name: "Agregar al primero" }).click();
  await page.getByRole("textbox", { name: "Nombre de la persona 1" }).fill("Dra. Pérez E2E");
  await page.locator("#mnEquipo").getByRole("button", { name: "Agregar persona" }).click();
  await page.getByRole("textbox", { name: "Nombre de la persona 2" }).fill("Fila a quitar");
  await page.locator(".equipo-fila").nth(1).locator("button").click();
  await expect(page.locator(".equipo-fila")).toHaveCount(1);
  // Solo hace "Valoración".
  await page.locator(".equipo-fila").first().locator(".mn-check", { hasText: "Valoración" }).locator("input").check();
  await expect(page.locator(".equipo-servicios-label")).not.toContainText("(todo)");

  // Horario: domingo cerrado; lunes abre 09:00.
  const domingo = page.locator(".horario-fila").nth(0);
  await domingo.locator(".switch").click();
  await expect(domingo.locator(".horario-chip")).toHaveText("Cerrado");
  await expect(page.locator("#hAbre0")).toBeDisabled();
  await page.locator("#hAbre1").fill("09:00");

  // Feriados: agregar dos, quitar uno.
  await page.getByRole("button", { name: "+ Agregar bloqueo" }).click();
  await page.getByRole("button", { name: "+ Agregar bloqueo" }).click();
  const filas = page.locator(".feriado-fila");
  await filas.nth(0).locator('input[type="date"]').nth(0).fill("2027-12-24");
  await filas.nth(0).locator('input[type="date"]').nth(1).fill("2027-12-26");
  await filas.nth(0).locator(".feriado-motivo").fill("Navidad E2E");
  await filas.nth(1).getByRole("button", { name: "Quitar" }).click();
  await expect(filas).toHaveCount(1);
  await guardar(page);

  const cfg = await (await api.get("/api/panel/config")).json();
  expect(cfg.empleados).toEqual([{ id: "dra-perez-e2e", nombre: "Dra. Pérez E2E", activo: true, serviciosIds: ["valoracion"] }]);
  expect(cfg.horario[0]).toEqual({ abre: null, cierra: null });
  expect(cfg.horario[1]).toEqual({ abre: "09:00", cierra: "18:00" });
  expect(cfg.bloqueos).toEqual([{ desde: "2027-12-24", hasta: "2027-12-26", motivo: "Navidad E2E" }]);

  // Persona inactiva: queda con estilo inactivo tras guardar.
  await page.reload();
  await abrirMiNegocio(page);
  await page.locator(".equipo-fila").first().locator(".mn-check", { hasText: "Activo" }).locator("input").uncheck();
  await expect(page.locator(".equipo-fila").first()).toHaveClass(/equipo-fila-inactiva/);
  await guardar(page);
  const cfg2 = await (await api.get("/api/panel/config")).json();
  expect(cfg2.empleados[0].activo).toBe(false);
});

test("base de conocimiento y FAQ: ítems (Enter agrega fila), secciones propias, preguntas", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  await abrirMiNegocio(page);
  const kb = page.locator("#mnBaseConocimiento");
  const general = kb.locator(".kb-grupo").nth(0);
  const nAntes = await general.locator(".kb-item").count();
  await general.getByRole("button", { name: "+ Agregar dato" }).click();
  const ultimo = general.locator(".kb-item-input").last();
  await ultimo.fill("Dato E2E uno");
  await ultimo.press("Enter"); // Enter en la última fila con texto → agrega otra
  await expect(general.locator(".kb-item")).toHaveCount(nAntes + 2);
  await general.locator(".kb-item-input").last().fill("Dato E2E dos");
  await expect(general.locator(".kb-count")).toHaveText(String(nAntes + 2));
  // Quitar el último.
  await general.locator(".kb-item").last().getByTitle("Quitar").click();

  const politicas = kb.locator(".kb-grupo").nth(1);
  await politicas.getByRole("button", { name: "+ Agregar política" }).click();
  await politicas.locator(".kb-item-input").last().fill("Política E2E");

  // Sección propia: título + 2 datos; y una sección vacía que se descarta al guardar.
  const secciones = kb.locator(".kb-grupo").nth(2);
  const btnSeccion = secciones.getByRole("button", { name: /Agregar sección/ }).first();
  await btnSeccion.click();
  const sec = secciones.locator(".kb-seccion").last();
  await sec.locator(".kb-seccion-titulo").fill("Promociones E2E");
  await sec.locator(".kb-item-input").first().fill("2x1 los martes");
  await sec.getByRole("button", { name: "+ Agregar dato" }).click();
  await sec.locator(".kb-item-input").last().fill("10% a estudiantes");

  // FAQ: agregar dos, quitar una.
  const faq = page.locator("#mnFaq");
  const nFaq = await faq.locator(".admin-faq").count();
  await faq.getByRole("button", { name: "+ Agregar pregunta" }).click();
  await faq.getByRole("button", { name: "+ Agregar pregunta" }).click();
  await faq.locator(".admin-faq").nth(nFaq).locator("input").nth(0).fill("¿Pregunta E2E?");
  await faq.locator(".admin-faq").nth(nFaq).locator("input").nth(1).fill("Respuesta E2E");
  await faq.locator(".admin-faq").nth(nFaq + 1).getByRole("button", { name: "Quitar" }).click();
  await guardar(page);

  const cfg = await (await api.get("/api/panel/config")).json();
  expect(cfg.kb.datos).toContain("Dato E2E uno");
  expect(cfg.kb.datos).not.toContain("Dato E2E dos");
  expect(cfg.kb.politicas).toContain("Política E2E");
  expect(cfg.kb.secciones.find((s: { titulo: string }) => s.titulo === "Promociones E2E")?.items).toEqual(["2x1 los martes", "10% a estudiantes"]);
  expect(cfg.kb.faq).toContainEqual({ pregunta: "¿Pregunta E2E?", respuesta: "Respuesta E2E" });
  expect(cfg.kb.faq).toHaveLength(nFaq + 1);

  // Quitar la sección (ícono de basura del encabezado).
  await page.reload();
  await abrirMiNegocio(page);
  await page.locator(".kb-seccion", { has: page.locator('.kb-seccion-titulo[value="Promociones E2E"]') }).getByTitle("Quitar sección").click();
  await guardar(page);
  const cfg2 = await (await api.get("/api/panel/config")).json();
  expect(cfg2.kb.secciones.some((s: { titulo: string }) => s.titulo === "Promociones E2E")).toBe(false);
});

for (const [nombre, sel, valor, error] of [
  ["logo sin https", "#cLogoUrl", "http://inseguro.example/logo.png", "URL del logo inválida"],
  ["plantilla con mayúsculas/espacios", "#cPlantillaMkt", "Promo General", "Nombre de plantilla inválido"],
  ["idioma de plantilla raro", "#cPlantillaIdioma", "español!!", "Idioma de plantilla inválido"],
  ["link de reseñas que no es URL", "#cLinkResenas", "no-es-una-url", "Link de reseñas inválido"],
  ["horas de rescate fuera de rango", "#cRescateHoras", "100", "Horas de espera del rescate inválidas"],
  ["calendario que no es correo", "#cGoogleCalendarId", "no es un correo", "ID de Google Calendar inválido"],
] as const) {
  test(`validación del backend: ${nombre} → toast con el error y no se guarda`, async ({ page }) => {
    await entrar(page, USUARIOS.clinica);
    await abrirMiNegocio(page);
    await page.locator(sel).fill(valor);
    await barra(page).getByRole("button", { name: "Guardar cambios" }).click();
    await esperarToast(page, error);
    await expect(barra(page)).toContainText("Cambios sin guardar");
  });
}

test("validación: bloqueo con 'desde' posterior a 'hasta' se rechaza", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  await abrirMiNegocio(page);
  await page.getByRole("button", { name: "+ Agregar bloqueo" }).click();
  const fila = page.locator(".feriado-fila").last();
  await fila.locator('input[type="date"]').nth(0).fill("2027-05-10");
  await fila.locator('input[type="date"]').nth(1).fill("2027-05-01");
  await barra(page).getByRole("button", { name: "Guardar cambios" }).click();
  await esperarToast(page, "Hay un bloqueo inválido");
});

test("validación: horario que cierra antes de abrir NO debería aceptarse", async () => {
  const cfg = await (await api.get("/api/panel/config")).json();
  const r = await api.post("/api/panel/config", { data: { ...cfg, horario: { ...cfg.horario, 2: { abre: "18:00", cierra: "08:00" } } } });
  expect(r.status(), "un horario invertido deja el día sin cupos sin avisarle al dueño").toBe(400);
});

test("guardar desde la UI no borra campos que la UI no muestra (mensajeTopeExcedido)", async ({ page }) => {
  const cfg = await (await api.get("/api/panel/config")).json();
  const r = await api.post("/api/panel/config", { data: { ...cfg, mensajeTopeExcedido: "Mensaje de tope E2E" } });
  expect(r.status(), await r.text()).toBe(200);
  expect((await (await api.get("/api/panel/me")).json()).mensajeTopeExcedido).toBe("Mensaje de tope E2E");
  await entrar(page, USUARIOS.clinica);
  await abrirMiNegocio(page);
  await page.locator("#cTono").fill("cambio cualquiera E2E");
  await guardar(page);
  expect((await (await api.get("/api/panel/me")).json()).mensajeTopeExcedido, "el guardado de Mi negocio pisó el mensaje de tope").toBe(
    "Mensaje de tope E2E",
  );
});

test("historial versionado (F15): cada guardado crea una versión y restaurar vuelve atrás", async () => {
  const h0 = (await (await api.get("/api/panel/config/historial")).json()).historial as { id: string }[];
  const cfg = await (await api.get("/api/panel/config")).json();
  expect((await api.post("/api/panel/config", { data: { ...cfg, tono: "versión A" } })).status()).toBe(200);
  expect((await api.post("/api/panel/config", { data: { ...cfg, tono: "versión B" } })).status()).toBe(200);
  const h1 = (await (await api.get("/api/panel/config/historial")).json()).historial as { id: string; snapshot: { tono: string } }[];
  expect(h1.length).toBe(h0.length + 2);
  const versionA = h1.find((v) => v.snapshot?.tono === "versión A");
  expect(versionA, "el historial no guarda el snapshot").toBeTruthy();
  expect((await api.post("/api/panel/config/restaurar", { data: { historialId: versionA!.id } })).status()).toBe(200);
  expect((await (await api.get("/api/panel/config")).json()).tono).toBe("versión A");
  expect((await api.post("/api/panel/config/restaurar", { data: { historialId: "no-existe" } })).status()).toBe(404);
});

test("plan Básico: Marca, upsell, Place ID y rescate aparecen bloqueados (🔒) y el guardado funciona", async ({ page, playwright }) => {
  await entrar(page, USUARIOS.basico);
  await abrirMiNegocio(page);
  await expect(page.locator("#mnMarca .badge-pro")).toContainText("Plan Pro");
  await expect(page.locator("#cLogoUrl")).toHaveCount(0);
  await expect(page.locator("#mnServicios .badge-pro")).toContainText("Upsell Pro");
  await expect(page.locator(".svc-switch-row", { hasText: "Ofrecer add-on" })).toHaveCount(0);
  await expect(page.locator("#cGooglePlaceId")).toHaveCount(0);
  await expect(page.locator("#mnRescate .switch")).toHaveCount(0);
  await page.locator("#cTono").fill("tono básico E2E");
  await guardar(page);
  // El backend también gatea: un POST directo con marca → 403 plan_requerido.
  const basico = await apiComo(playwright, USUARIOS.basico);
  const cfg = await (await basico.get("/api/panel/config")).json();
  const r = await basico.post("/api/panel/config", { data: { ...cfg, colorAcento: "#123456" } });
  expect(r.status()).toBe(403);
  expect((await r.json()).error).toBe("plan_requerido");
});

test("operador: no puede leer el historial ni guardar la config (403)", async ({ playwright }) => {
  const op = await apiComo(playwright, USUARIOS.clinicaOp);
  expect((await op.get("/api/panel/config/historial")).status()).toBe(403);
  const cfg = await (await op.get("/api/panel/config")).json();
  expect((await op.post("/api/panel/config", { data: cfg })).status()).toBe(403);
});
