import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { USUARIOS } from "./constantes";
import { apiComo, entrar, esperarToast, hoyCR, sumarDias, vigilarConsola } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Agenda (C2.1 + ALTO-07): vistas día/semana, navegación, alta manual por la UI con
// todas sus validaciones, choques de horario, detalle con cada acción (confirmar,
// reprogramar, completar, no-show, cancelar), bloqueos y el equipo (carriles,
// "Quién atiende", reasignación y 409 por persona ocupada).
// ─────────────────────────────────────────────────────────────────────────────

/** Etiqueta "Dom 4" que pinta la agenda para una fecha. */
function etiqueta(fecha: string): string {
  const d = new Date(`${fecha}T12:00:00`);
  return `${["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"][d.getDay()]} ${d.getDate()}`;
}

async function abrirAgenda(page: Page) {
  await page.locator(".hd-tab", { hasText: "Agenda" }).click();
  await expect(page.locator("#agenda")).toBeVisible();
}

async function irADia(page: Page, fecha: string) {
  // Navega con "Siguiente/Anterior" desde hoy hasta la fecha pedida.
  await page.getByRole("button", { name: "Hoy" }).click();
  const dias = Math.round((Date.parse(fecha) - Date.parse(hoyCR())) / 86_400_000);
  const boton = page.getByRole("button", { name: dias >= 0 ? "Siguiente" : "Anterior" });
  for (let i = 0; i < Math.abs(dias); i++) await boton.click();
  await expect(page.locator(".agenda-nav-fecha")).toHaveText(etiqueta(fecha));
}

async function elegirPrimeraHora(page: Page): Promise<string> {
  const sel = page.locator("#aHora");
  await expect(sel).toBeEnabled();
  await expect(sel.locator("option").nth(1)).toBeAttached();
  const hora = (await sel.locator("option").nth(1).getAttribute("value"))!;
  await sel.selectOption(hora);
  return hora;
}

async function crearCitaApi(api: APIRequestContext, datos: Record<string, unknown>): Promise<string> {
  const r = await api.post("/api/panel/citas", { data: datos });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()).cita.id;
}

test("vista día de hoy: timeline, resumen (citas, ingreso, en riesgo) y 'Ver en la agenda →' resalta la cita", async ({ page }) => {
  const errores = vigilarConsola(page);
  await entrar(page, USUARIOS.clinica);
  await abrirAgenda(page);
  await expect(page.locator(".agenda-nav-fecha")).toHaveText(etiqueta(hoyCR()));
  await expect(page.locator(".agenda-timeline-card h3")).toContainText("Citas del día");
  const bloques = page.locator(".agenda-bloque");
  expect(await bloques.count()).toBeGreaterThanOrEqual(3);
  await expect(page.locator(".agenda-resumen-fila", { hasText: "Ingreso estimado" }).locator("b")).toContainText("₡");
  await expect(page.locator(".agenda-resumen-fila", { hasText: "Ingreso estimado" })).not.toContainText("NaN");
  await expect(page.locator(".agenda-resumen-fila", { hasText: "Sin confirmar" }).locator(".chip-alerta")).toContainText("en riesgo");
  const aviso = page.locator(".agenda-aviso-riesgo");
  await expect(aviso).toContainText("no confirmó");
  await aviso.getByRole("button", { name: "Ver en la agenda →" }).click();
  await expect(page.locator(".agenda-bloque.agenda-bloque-resaltado")).toHaveCount(1);
  await expect(page.locator(".agenda-bloque.agenda-bloque-resaltado")).toContainText("Sin confirmar");
  expect(errores, errores.join("\n")).toEqual([]);
});

test("navegación: Siguiente/Anterior/Hoy y vista Semana (7 días, hoy marcado, chip → vista día)", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  await abrirAgenda(page);
  const hoy = hoyCR();
  await page.getByRole("button", { name: "Siguiente" }).click();
  await expect(page.locator(".agenda-nav-fecha")).toHaveText(etiqueta(sumarDias(hoy, 1)));
  await page.getByRole("button", { name: "Anterior" }).click();
  await page.getByRole("button", { name: "Anterior" }).click();
  await expect(page.locator(".agenda-nav-fecha")).toHaveText(etiqueta(sumarDias(hoy, -1)));
  await page.getByRole("button", { name: "Hoy" }).click();
  await expect(page.locator(".agenda-nav-fecha")).toHaveText(etiqueta(hoy));

  await page.getByRole("button", { name: "Semana", exact: true }).click();
  await expect(page.locator(".agenda-dia-col")).toHaveCount(7);
  await expect(page.locator(".agenda-dia-col.hoy")).toHaveCount(1);
  await expect(page.locator(".agenda-nav-fecha")).toContainText("–");
  // Siguiente en semana salta 7 días.
  const antes = await page.locator(".agenda-nav-fecha").textContent();
  await page.getByRole("button", { name: "Siguiente" }).click();
  await expect(page.locator(".agenda-nav-fecha")).not.toHaveText(antes!);
  await page.getByRole("button", { name: "Hoy" }).click();
  const chip = page.locator(".agenda-dia-col.hoy .agenda-chip").first();
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByRole("button", { name: "Día", exact: true })).toHaveClass(/activo/);
  await expect(page.locator(".agenda-nav-fecha")).toHaveText(etiqueta(hoy));
});

test("día sin citas: estado vacío y 'Agendá la primera' abre el alta PARA ESE DÍA", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  await abrirAgenda(page);
  const vacio = sumarDias(hoyCR(), 3);
  await irADia(page, vacio);
  await expect(page.getByText("Sin citas para este día")).toBeVisible();
  await page.getByRole("button", { name: "Agendá la primera" }).click();
  await expect(page.locator("#agendaForm")).toBeVisible();
  await expect(page.locator("#aFecha")).toHaveValue(vacio);
});

test("alta manual por la UI: validaciones, precio precargado, teléfono solo dígitos y la cita aparece", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  await abrirAgenda(page);
  await page.getByRole("button", { name: "Nueva cita" }).click();
  const form = page.locator("#agendaForm");
  const guardar = form.getByRole("button", { name: /^Guardar/ });
  await expect(guardar).toBeDisabled();

  await page.locator("#aCliente").fill("Paciente UI E2E");
  await page.locator("#aTelefono").fill("+506 8812-3456");
  await expect(page.locator("#aTelefono")).toHaveValue("50688123456");
  await page.locator("#aServicio").selectOption("valoracion");
  await expect(page.locator("#aPrecio")).toHaveValue("15000");
  await page.locator("#aServicio").selectOption("blanqueamiento");
  await expect(page.locator("#aPrecio")).toHaveValue("120000");
  const fecha = sumarDias(hoyCR(), 4);
  await page.locator("#aFecha").fill(fecha);
  await expect(guardar).toBeDisabled(); // falta la hora
  const hora = await elegirPrimeraHora(page);
  await page.locator("#aPlaca").fill("REF-UI-1");
  await expect(guardar).toBeEnabled();
  await guardar.click();
  await esperarToast(page, "Cita creada");
  await expect(form).toHaveCount(0);

  await irADia(page, fecha);
  const bloque = page.locator(".agenda-bloque", { hasText: "Paciente UI E2E" });
  await expect(bloque).toContainText(hora);
  await expect(bloque).toContainText("REF-UI-1");
  await expect(bloque).toContainText("Pendiente");
});

test("alta manual: fecha pasada la rechaza el backend con un mensaje claro", async ({ page }) => {
  await entrar(page, USUARIOS.clinica);
  await abrirAgenda(page);
  await page.getByRole("button", { name: "Nueva cita" }).click();
  await page.locator("#aCliente").fill("Pasado E2E");
  await page.locator("#aTelefono").fill("50688000001");
  await page.locator("#aFecha").fill(sumarDias(hoyCR(), -3));
  await elegirPrimeraHora(page);
  await page.locator("#agendaForm").getByRole("button", { name: /^Guardar/ }).click();
  await esperarToast(page, "No se puede agendar una fecha pasada");
  await expect(page.locator("#agendaForm")).toBeVisible(); // el modal sigue abierto para corregir
  await page.locator("#agendaForm .ficha-head button").click();
  await expect(page.locator("#agendaForm")).toHaveCount(0);
});

test("choque de horario: la hora ocupada se marca, avisa y permite 'Guardar igual' (walk-in)", async ({ page, playwright }) => {
  const api = await apiComo(playwright, USUARIOS.clinica);
  const fecha = sumarDias(hoyCR(), 5);
  await crearCitaApi(api, { clienteNombre: "Ocupa Hora", clienteWa: "50688000002", servicioId: "valoracion", fecha, hora: "15:00" });
  await entrar(page, USUARIOS.clinica);
  await abrirAgenda(page);
  await page.getByRole("button", { name: "Nueva cita" }).click();
  await page.locator("#aCliente").fill("Walk-in E2E");
  await page.locator("#aTelefono").fill("50688000003");
  await page.locator("#aServicio").selectOption("valoracion");
  await page.locator("#aFecha").fill(fecha);
  await expect(page.locator("#aHora")).toBeEnabled();
  await expect(page.locator("#aHora option", { hasText: "15:00 — ocupado (Ocupa Hora)" })).toBeAttached();
  await page.locator("#aHora").selectOption("15:00");
  await expect(page.getByText("Ese horario ya tiene una cita con Ocupa Hora")).toBeVisible();
  await page.getByRole("button", { name: "Guardar igual" }).click();
  await esperarToast(page, "Cita creada");
});

test("detalle de cita: Confirmar, Reprogramar, Completar, No se presentó y Cancelar actualizan el estado", async ({ page, playwright }) => {
  const api = await apiComo(playwright, USUARIOS.clinica);
  const fecha = sumarDias(hoyCR(), 6);
  const nombres = ["Acc Confirmar", "Acc Reprogramar", "Acc Completar", "Acc NoShow", "Acc Cancelar"];
  for (const [i, n] of nombres.entries()) {
    await crearCitaApi(api, { clienteNombre: n, clienteWa: `5068800010${i}`, servicioId: "valoracion", fecha, hora: `${String(9 + i).padStart(2, "0")}:00`, precio: 15000 });
  }
  await entrar(page, USUARIOS.clinica);
  await abrirAgenda(page);
  await irADia(page, fecha);
  const modal = page.locator(".ficha-modal");
  const abrir = async (n: string) => {
    await page.locator(".agenda-bloque", { hasText: n }).click();
    await expect(modal.locator("h3")).toHaveText(n);
  };

  await abrir("Acc Confirmar");
  await expect(modal.locator(".dato", { hasText: "Total" })).toContainText("₡");
  await modal.getByRole("button", { name: "Confirmar" }).click();
  await esperarToast(page, "Cita confirmada");
  await expect(page.locator(".agenda-bloque", { hasText: "Acc Confirmar" })).toContainText("Confirmada");
  await abrir("Acc Confirmar");
  await expect(modal.getByRole("button", { name: "Confirmar" })).toHaveCount(0); // ya confirmada
  await modal.locator(".ficha-head button").click();

  await abrir("Acc Completar");
  await modal.getByRole("button", { name: "Completar" }).click();
  await esperarToast(page, "Cita marcada como completada");
  await expect(page.locator(".agenda-bloque", { hasText: "Acc Completar" })).toContainText("Completada");
  await abrir("Acc Completar");
  await expect(modal.locator(".agenda-detalle-acciones")).toHaveCount(0); // sin acciones al terminar
  await page.locator(".overlay").click({ position: { x: 5, y: 5 } });

  await abrir("Acc NoShow");
  await modal.getByRole("button", { name: "No se presentó" }).click();
  await esperarToast(page, "Cita marcada como no-show");
  await expect(page.locator(".agenda-bloque", { hasText: "Acc NoShow" })).toContainText("No-show");

  await abrir("Acc Cancelar");
  await modal.getByRole("button", { name: "Cancelar" }).click();
  await esperarToast(page, "Cita cancelada");
  await expect(page.locator(".agenda-bloque", { hasText: "Acc Cancelar" })).toContainText("Cancelada");

  // Reprogramar: el modal ofrece su propia hora (no la ve como choque) y mueve la cita.
  await abrir("Acc Reprogramar");
  await modal.getByRole("button", { name: "Reprogramar" }).click();
  const form = page.locator("#agendaForm");
  await expect(form.locator("h3")).toHaveText("Reprogramar cita");
  await expect(page.locator("#aCliente")).toHaveCount(0);
  await expect(page.locator("#aHora")).toHaveValue("10:00");
  await expect(page.locator("#aHora option", { hasText: "10:00 — ocupado" })).toHaveCount(0);
  const nueva = sumarDias(fecha, 1);
  await page.locator("#aFecha").fill(nueva);
  await elegirPrimeraHora(page);
  await form.getByRole("button", { name: /^Guardar/ }).click();
  await esperarToast(page, "Cita reprogramada");
  await expect(page.locator(".agenda-bloque", { hasText: "Acc Reprogramar" })).toHaveCount(0);
  await irADia(page, nueva);
  await expect(page.locator(".agenda-bloque", { hasText: "Acc Reprogramar" })).toBeVisible();

  // El resumen no cuenta las canceladas y el ingreso solo suma agendadas/completadas.
  await irADia(page, fecha);
  await expect(page.locator(".agenda-resumen-fila", { hasText: "Citas" }).locator("b")).toHaveText("3"); // confirmar, completar, noshow
  await expect(page.locator(".agenda-resumen-fila", { hasText: "Ingreso estimado" }).locator("b")).toHaveText(/30[.,\s ]?000/);
});

test.describe.serial("con bloqueos y equipo cargados (se restaura la config al final)", () => {
  let api: APIRequestContext;
  let configOriginal: Record<string, unknown>;
  const fechaBloqueada = sumarDias(hoyCR(), 9);
  const fechaEquipo = sumarDias(hoyCR(), 10);

  test.beforeAll(async ({ playwright }) => {
    api = await apiComo(playwright, USUARIOS.clinica);
    configOriginal = await (await api.get("/api/panel/config")).json();
    const r = await api.post("/api/panel/config", {
      data: {
        ...configOriginal,
        bloqueos: [{ desde: fechaBloqueada, hasta: fechaBloqueada, motivo: "Feriado E2E" }],
        empleados: [
          { id: "", nombre: "Ana E2E", activo: true },
          { id: "", nombre: "Marco E2E", activo: true },
        ],
      },
    });
    expect(r.status(), await r.text()).toBe(200);
  });

  test.afterAll(async () => {
    // Las citas asignadas bloquean borrar al equipo: se cancelan antes de restaurar.
    const citas = (await (await api.get(`/api/panel/citas?desde=${fechaEquipo}&hasta=${fechaEquipo}`)).json()).citas as { id: string; estado: string }[];
    for (const c of citas) if (c.estado === "agendada") await api.post(`/api/panel/citas/${c.id}/cancelar`);
    const r = await api.post("/api/panel/config", { data: configOriginal });
    expect(r.status(), await r.text()).toBe(200);
  });

  test("fecha bloqueada (feriado): el alta avisa que no hay horarios", async ({ page }) => {
    await entrar(page, USUARIOS.clinica);
    await abrirAgenda(page);
    await page.getByRole("button", { name: "Nueva cita" }).click();
    await page.locator("#aFecha").fill(fechaBloqueada);
    await expect(page.getByText("No hay horarios disponibles para esa fecha y servicio")).toBeVisible();
    await expect(page.locator("#aHora option")).toHaveCount(1); // solo el placeholder
  });

  test("equipo: carriles por persona, 'Quién atiende' en el alta, persona ocupada deshabilitada y 409", async ({ page }) => {
    const me = await (await api.get("/api/panel/me")).json();
    const ana = me.empleados.find((e: { nombre: string }) => e.nombre === "Ana E2E");
    const marco = me.empleados.find((e: { nombre: string }) => e.nombre === "Marco E2E");
    expect(ana?.id).toBeTruthy();
    await crearCitaApi(api, { clienteNombre: "Con Ana", clienteWa: "50688000201", servicioId: "valoracion", fecha: fechaEquipo, hora: "09:00", empleadoId: ana.id });
    await crearCitaApi(api, { clienteNombre: "Sin asignar E2E", clienteWa: "50688000202", servicioId: "valoracion", fecha: fechaEquipo, hora: "09:00" });
    const choque = await api.post("/api/panel/citas", {
      data: { clienteNombre: "Choque", clienteWa: "50688000203", servicioId: "valoracion", fecha: fechaEquipo, hora: "09:00", empleadoId: ana.id },
    });
    expect(choque.status()).toBe(409);
    expect((await choque.json()).error).toContain("Ana E2E");

    await entrar(page, USUARIOS.clinica);
    await abrirAgenda(page);
    await irADia(page, fechaEquipo);
    await expect(page.locator(".agenda-carril-nombre")).toHaveText(["Ana E2E", "Marco E2E", "Sin asignar"]);
    await expect(page.locator(".agenda-bloque.agenda-bloque-carril")).toHaveCount(2);

    await page.getByRole("button", { name: "Nueva cita" }).click();
    await page.locator("#aServicio").selectOption("valoracion");
    await page.locator("#aFecha").fill(fechaEquipo);
    await expect(page.locator("#aHora")).toBeEnabled();
    await page.locator("#aHora").selectOption("09:00");
    await expect(page.locator(`#aEmpleado option[value="${ana.id}"]`)).toBeDisabled();
    await expect(page.locator(`#aEmpleado option[value="${ana.id}"]`)).toContainText("ocupado a esa hora");
    await expect(page.locator(`#aEmpleado option[value="${marco.id}"]`)).toBeEnabled();
    await page.locator("#aCliente").fill("Con Marco");
    await page.locator("#aTelefono").fill("50688000204");
    await page.locator("#aEmpleado").selectOption(marco.id);
    await page.locator("#agendaForm").getByRole("button", { name: /^Guardar/ }).click();
    await esperarToast(page, "Cita creada");
    await expect(page.locator(".agenda-bloque.agenda-bloque-carril")).toHaveCount(3);
  });

  test("equipo: reasignar desde el detalle (ok y 409 si la persona ya tiene cita)", async ({ page }) => {
    await entrar(page, USUARIOS.clinica);
    await abrirAgenda(page);
    await irADia(page, fechaEquipo);
    await page.locator(".agenda-bloque", { hasText: "Sin asignar E2E" }).click();
    const sel = page.getByRole("combobox", { name: "Quién atiende" });
    await expect(sel).toHaveValue("");
    await sel.selectOption({ label: "Ana E2E" }); // Ana ya tiene "Con Ana" a las 09:00 → 409
    await esperarToast(page, "Ana E2E ya tiene una cita a esa hora");

    await page.locator(".agenda-bloque", { hasText: "Con Marco" }).click();
    await page.getByRole("combobox", { name: "Quién atiende" }).selectOption("");
    await esperarToast(page, "Cita reasignada");
    await page.locator(".agenda-bloque", { hasText: "Con Marco" }).click();
    await expect(page.getByRole("combobox", { name: "Quién atiende" })).toHaveValue("");
  });

  test("Mi negocio: no deja borrar a alguien con citas agendadas (409) — hay que desactivarlo", async () => {
    const cfg = await (await api.get("/api/panel/config")).json();
    const r = await api.post("/api/panel/config", {
      data: { ...cfg, empleados: cfg.empleados.filter((e: { nombre: string }) => e.nombre !== "Ana E2E") },
    });
    expect(r.status()).toBe(409);
    expect((await r.json()).error).toContain("Ana E2E");
    const desactivar = await api.post("/api/panel/config", {
      data: { ...cfg, empleados: cfg.empleados.map((e: { nombre: string }) => (e.nombre === "Ana E2E" ? { ...e, activo: false } : e)) },
    });
    expect(desactivar.status(), await desactivar.text()).toBe(200);
  });
});

test("API agenda: validaciones (fecha/hora inválidas, servicio no agendable, sin nombre) y 404 de citas ajenas", async ({ playwright }) => {
  const api = await apiComo(playwright, USUARIOS.clinica);
  const fecha = sumarDias(hoyCR(), 7);
  const base = { clienteNombre: "Val", clienteWa: "50688000300", servicioId: "valoracion", fecha, hora: "10:00" };
  expect((await api.post("/api/panel/citas", { data: { ...base, hora: "25:00" } })).status()).toBe(400);
  expect((await api.post("/api/panel/citas", { data: { ...base, fecha: "2026-13-45x" } })).status()).toBe(400);
  expect((await api.post("/api/panel/citas", { data: { ...base, servicioId: "fluor" } })).status()).toBe(400); // no agendable
  expect((await api.post("/api/panel/citas", { data: { ...base, clienteNombre: "  " } })).status()).toBe(400);
  expect((await api.get("/api/panel/citas?desde=hoy&hasta=mañana")).status()).toBe(400);
  expect((await api.get(`/api/panel/citas/disponibilidad?fecha=${fecha}&servicioId=no-existe`)).status()).toBe(400);
  const id = await crearCitaApi(api, base);
  const basico = await apiComo(playwright, USUARIOS.basico);
  expect((await basico.post(`/api/panel/citas/${id}/cancelar`)).status()).toBe(404);
  expect((await basico.post(`/api/panel/citas/${id}/reprogramar`, { data: { fecha, hora: "11:00" } })).status()).toBe(404);
  expect((await api.post(`/api/panel/citas/${id}/reprogramar`, { data: { fecha: sumarDias(hoyCR(), -1), hora: "11:00" } })).status()).toBe(400);
  expect((await api.post(`/api/panel/citas/no-existe/confirmar`)).status()).toBe(404);
});
