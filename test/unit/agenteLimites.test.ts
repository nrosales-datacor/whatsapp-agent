import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ejecutarTool, MAX_LARGO_NOMBRE, textoLibre } from "../../src/agent/runAgent";
import { repoDePrueba, type RepoDePrueba } from "../helpers/repoDePrueba";
import type { Service, Tenant } from "../../src/types";
import { crearTenant } from "../helpers/fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Guards de la revisión pre-venta 2026-10, invocando `ejecutarTool` directo (sin LLM):
//  - tope de citas activas por número de WhatsApp (un bromista no llena la agenda);
//  - texto libre de las tools (nombre, placa) acotado y limpio;
//  - upsell entre turnos: "sí, agregalo" en el mensaje SIGUIENTE funciona aunque el
//    modelo ya no tenga el citaId (el historial solo guarda texto).
// ─────────────────────────────────────────────────────────────────────────────

const CLIENTE = "50688887777";

/** Un día hábil futuro (el tenant de prueba abre lunes a sábado), a `semanas` de hoy. */
function lunesEn(semanas: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7 * semanas);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function contexto(tenant: Tenant, repo?: RepoDePrueba, clienteWa = CLIENTE) {
  return { tenant, repo: repo ?? (await repoDePrueba()), clienteWa };
}

async function correr(ctx: Awaited<ReturnType<typeof contexto>>, nombre: string, args: Record<string, unknown>): Promise<any> {
  return JSON.parse(await ejecutarTool(nombre, args, ctx, {}));
}

const agendar = (fecha: string, extra: Record<string, unknown> = {}) => ({
  nombre: "Cliente",
  servicioId: "lavado-basico",
  fecha,
  hora: "09:00",
  ...extra,
});

afterEach(() => {
  delete process.env.MAX_CITAS_ACTIVAS_POR_CLIENTE;
});

// ── Tope de citas activas por número ──

test("agendar_cita: con 3 citas activas (default) el número no puede agendar una 4ª", async () => {
  const ctx = await contexto(crearTenant());
  for (let i = 1; i <= 3; i++) {
    const r = await correr(ctx, "agendar_cita", agendar(lunesEn(i)));
    assert.equal(r.ok, true, `la cita ${i} debía agendarse`);
  }
  const r = await correr(ctx, "agendar_cita", agendar(lunesEn(4)));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /máximo por cliente es 3/);
  assert.equal(r.citasActivas.length, 3, "devuelve las citas para ofrecer reprogramar/cancelar");
  assert.equal((await ctx.repo.citasActivasCliente(ctx.tenant.id, CLIENTE, lunesEn(0))).length, 3);
});

test("agendar_cita: el tope es por número — otro cliente sí puede agendar", async () => {
  process.env.MAX_CITAS_ACTIVAS_POR_CLIENTE = "1";
  const repo = await repoDePrueba();
  const tenant = crearTenant();
  assert.equal((await correr(await contexto(tenant, repo), "agendar_cita", agendar(lunesEn(1)))).ok, true);
  assert.equal((await correr(await contexto(tenant, repo), "agendar_cita", agendar(lunesEn(2)))).ok, false);
  assert.equal((await correr(await contexto(tenant, repo, "50677776666"), "agendar_cita", agendar(lunesEn(2)))).ok, true);
});

test("agendar_cita: una cita cancelada libera el cupo", async () => {
  process.env.MAX_CITAS_ACTIVAS_POR_CLIENTE = "1";
  const ctx = await contexto(crearTenant());
  const primera = await correr(ctx, "agendar_cita", agendar(lunesEn(1)));
  assert.equal(primera.ok, true);
  assert.equal((await correr(ctx, "cancelar_cita", {})).ok, true);
  assert.equal((await correr(ctx, "agendar_cita", agendar(lunesEn(2)))).ok, true);
});

// ── Texto libre acotado ──

test("agendar_cita: nombre larguísimo con saltos de línea se limpia y trunca; placa también", async () => {
  const ctx = await contexto(crearTenant());
  const nombre = "Juan\n\nPérez\u0000 " + "x".repeat(5000);
  const r = await correr(ctx, "agendar_cita", agendar(lunesEn(1), { nombre, placa: "ABC-123\n" + "9".repeat(100) }));
  assert.equal(r.ok, true);
  assert.equal(Array.from(r.cita.clienteNombre).length <= MAX_LARGO_NOMBRE, true);
  assert.ok(r.cita.clienteNombre.startsWith("Juan Pérez x"), r.cita.clienteNombre);
  assert.doesNotMatch(r.cita.clienteNombre, /[\n\u0000]/);
  assert.ok(r.cita.placa.length <= 20);
  assert.doesNotMatch(r.cita.placa, /\n/);
});

test("agendar_cita: sin nombre usable (vacío o solo espacios) no agenda", async () => {
  const ctx = await contexto(crearTenant());
  const r = await correr(ctx, "agendar_cita", agendar(lunesEn(1), { nombre: " \n\t " }));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /nombre/);
});

test("textoLibre: no corta un emoji a la mitad", () => {
  assert.equal(textoLibre("👍👍👍", 2), "👍👍");
  assert.equal(textoLibre(undefined, 10), "");
});

// ── Upsell entre turnos ──

const SERVICIOS_UPSELL: Service[] = [
  {
    id: "limpieza_dental",
    nombre: "Limpieza dental",
    precio: 25000,
    duracionMin: 45,
    agendable: true,
    addonSugeridoId: "fluor",
    addonPrecioPromo: 8000,
    addonActivo: true,
  },
  { id: "fluor", nombre: "Aplicación de flúor", precio: 9000, duracionMin: 15 },
  { id: "control", nombre: "Control", precio: 10000, duracionMin: 30, agendable: true },
];

function tenantPro(): Tenant {
  return crearTenant({ plan: "pro", servicios: SERVICIOS_UPSELL });
}

test("agregar_addon_a_cita SIN citaId (turno siguiente): usa la única cita activa con ese add-on", async () => {
  const ctx = await contexto(tenantPro());
  const agendada = await correr(ctx, "agendar_cita", agendar(lunesEn(1), { servicioId: "limpieza_dental" }));
  assert.equal(agendada.addonSugerido.addonId, "fluor");
  // Otra cita activa SIN add-on configurado: no debe confundir la resolución.
  assert.equal((await correr(ctx, "agendar_cita", agendar(lunesEn(2), { servicioId: "control" }))).ok, true);

  const r = await correr(ctx, "agregar_addon_a_cita", { addonId: "fluor" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.cita.citaId, agendada.cita.id);
  const [cita] = (await ctx.repo.citasActivasCliente(ctx.tenant.id, CLIENTE, lunesEn(0))).filter(
    (c) => c.id === agendada.cita.id,
  );
  assert.deepEqual(cita.addons, [{ servicioId: "fluor", precio: 8000 }], "el precio sale de la config (promo), no del modelo");
});

test("agregar_addon_a_cita con un citaId INVENTADO: igual resuelve la cita del cliente", async () => {
  const ctx = await contexto(tenantPro());
  const agendada = await correr(ctx, "agendar_cita", agendar(lunesEn(1), { servicioId: "limpieza_dental" }));
  const r = await correr(ctx, "agregar_addon_a_cita", { citaId: "cita-123", addonId: "fluor" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.cita.citaId, agendada.cita.id);
});

test("agregar_addon_a_cita sin citaId y con DOS citas candidatas: no adivina, devuelve la lista", async () => {
  const ctx = await contexto(tenantPro());
  await correr(ctx, "agendar_cita", agendar(lunesEn(1), { servicioId: "limpieza_dental" }));
  await correr(ctx, "agendar_cita", agendar(lunesEn(2), { servicioId: "limpieza_dental" }));
  const r = await correr(ctx, "agregar_addon_a_cita", { addonId: "fluor" });
  assert.equal(r.ok, false);
  assert.equal(r.citas.length, 2);
});

test("agregar_addon_a_cita con un addonId distinto al configurado: se rechaza (no agrega otra cosa)", async () => {
  const ctx = await contexto(tenantPro());
  const agendada = await correr(ctx, "agendar_cita", agendar(lunesEn(1), { servicioId: "limpieza_dental" }));
  const r = await correr(ctx, "agregar_addon_a_cita", { citaId: agendada.cita.id, addonId: "control" });
  assert.equal(r.ok, false);
});

test("rechazar_addon sin citaId: registra el rechazo y la próxima cita ya no sugiere el add-on", async () => {
  const ctx = await contexto(tenantPro());
  await ctx.repo.obtenerOConversacion(ctx.tenant.id, CLIENTE); // el rechazo vive en la conversación
  await correr(ctx, "agendar_cita", agendar(lunesEn(1), { servicioId: "limpieza_dental" }));
  assert.equal((await correr(ctx, "rechazar_addon", { addonId: "fluor" })).ok, true);
  const otra = await correr(ctx, "agendar_cita", agendar(lunesEn(2), { servicioId: "limpieza_dental" }));
  assert.equal(otra.ok, true);
  assert.equal(otra.addonSugerido, undefined);
});
