import assert from "node:assert/strict";
import { test } from "node:test";
import { ejecutarTool } from "../../src/agent/runAgent";
import { repoDePrueba } from "../helpers/repoDePrueba";
import type { MensajeInteractivo, Tenant } from "../../src/types";
import { crearTenant } from "../helpers/fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Guards de las tools de agenda con equipo cargado (ALTO-07), invocando
// `ejecutarTool` directo: sin LLM, deterministas y gratis. Cubren el hueco que la
// auditoría marcaba en ALTO-18 ("cero tests del comportamiento del agente").
//
// Lo que se prueba acá es justo lo que NO puede quedar librado al modelo: que dos
// clientes puedan tener cita a la misma hora con personas distintas, y que a una
// misma persona no se le pueda encimar nunca una segunda cita.
// ─────────────────────────────────────────────────────────────────────────────

const CLIENTE = "50688887777";

/**
 * Un lunes futuro (el tenant de prueba abre lunes a sábado).
 *
 * A diferencia de `espaciosDisponibles`, los guards de `agendar_cita` usan el reloj REAL
 * — no hay `ahora` inyectable en `ejecutarTool` —, así que una fecha fija hardcodeada se
 * vuelve "pasada" con el calendario y estos tests empezarían a fallar solos. Se calcula
 * siempre a futuro para que el día del año no importe.
 */
function proximoLunes(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7); // bien lejos del borde de "hoy" y del margen de reserva
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const LUNES = proximoLunes();

const EQUIPO = [
  { id: "ana", nombre: "Ana", activo: true },
  { id: "marco", nombre: "Marco", activo: true },
];

async function contexto(tenant: Tenant) {
  return { tenant, repo: await repoDePrueba(), clienteWa: CLIENTE };
}

/** Corre una tool y devuelve el JSON parseado + lo que haya capturado como interactivo. */
async function correr(
  ctx: Awaited<ReturnType<typeof contexto>>,
  nombre: string,
  args: Record<string, unknown>,
): Promise<{ r: any; interactivo?: MensajeInteractivo }> {
  const capturas: { interactivo?: MensajeInteractivo } = {};
  const salida = await ejecutarTool(nombre, args, ctx, capturas);
  return { r: JSON.parse(salida), interactivo: capturas.interactivo };
}

const agendar = (extra: Record<string, unknown> = {}) => ({
  nombre: "Cliente",
  servicioId: "lavado-basico",
  fecha: LUNES,
  hora: "09:00",
  ...extra,
});

test("agendar_cita sin empleadoId asigna sola a alguien del equipo", async () => {
  const ctx = await contexto(crearTenant({ empleados: EQUIPO }));
  const { r } = await correr(ctx, "agendar_cita", agendar());
  assert.equal(r.ok, true);
  assert.ok(["ana", "marco"].includes(r.cita.empleadoId), `asignó a ${r.cita.empleadoId}`);
});

test("agendar_cita respeta la persona que pidió el cliente", async () => {
  const ctx = await contexto(crearTenant({ empleados: EQUIPO }));
  const { r } = await correr(ctx, "agendar_cita", agendar({ empleadoId: "marco" }));
  assert.equal(r.ok, true);
  assert.equal(r.cita.empleadoId, "marco");
});

test("dos clientes distintos SÍ pueden tener cita a la misma hora con personas distintas", async () => {
  const ctx = await contexto(crearTenant({ empleados: EQUIPO }));
  const a = await correr(ctx, "agendar_cita", agendar({ empleadoId: "ana" }));
  const b = await correr(ctx, "agendar_cita", agendar({ empleadoId: "marco" }));
  assert.equal(a.r.ok, true);
  assert.equal(b.r.ok, true);
  assert.equal((await ctx.repo.citasPorFecha(ctx.tenant.id, LUNES)).length, 2);
});

test("a una MISMA persona no se le puede encimar una segunda cita", async () => {
  const ctx = await contexto(crearTenant({ empleados: EQUIPO }));
  await correr(ctx, "agendar_cita", agendar({ empleadoId: "ana" }));
  const { r } = await correr(ctx, "agendar_cita", agendar({ empleadoId: "ana" }));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /Ana/);
  // El rechazo tiene que ser accionable: otros horarios de Ana y quién más está libre.
  assert.ok(!r.disponiblesDeEsaPersona.includes("09:00"));
  assert.deepEqual(
    r.disponiblesDeOtros.map((o: any) => o.empleadoId),
    ["marco"],
  );
});

test("cuando el equipo entero está ocupado, el horario se cae del todo", async () => {
  const ctx = await contexto(crearTenant({ empleados: EQUIPO }));
  await correr(ctx, "agendar_cita", agendar({ empleadoId: "ana" }));
  await correr(ctx, "agendar_cita", agendar({ empleadoId: "marco" }));
  const { r } = await correr(ctx, "agendar_cita", agendar());
  assert.equal(r.ok, false);
  assert.match(r.motivo, /ya no está disponible/);
  assert.ok(!r.disponibles.includes("09:00"));
});

test("agendar_cita rechaza un empleadoId que no existe", async () => {
  const ctx = await contexto(crearTenant({ empleados: EQUIPO }));
  const { r } = await correr(ctx, "agendar_cita", agendar({ empleadoId: "fulano" }));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no existe nadie/);
});

test("agendar_cita no asigna a nadie si el negocio no tiene equipo cargado", async () => {
  const ctx = await contexto(crearTenant());
  const { r } = await correr(ctx, "agendar_cita", agendar());
  assert.equal(r.ok, true);
  assert.equal(r.cita.empleadoId, undefined);
});

test("ofrecer_empleados muestra al equipo más la opción 'Cualquiera'", async () => {
  const ctx = await contexto(crearTenant({ empleados: EQUIPO }));
  const { r, interactivo } = await correr(ctx, "ofrecer_empleados", { servicioId: "lavado-basico" });
  assert.equal(r.ok, true);
  assert.deepEqual(
    interactivo?.opciones.map((o) => o.titulo),
    ["Ana", "Marco", "Cualquiera"],
  );
  assert.equal(interactivo?.opciones.at(-1)?.id, "empleado|lavado-basico|");
});

test("ofrecer_empleados no pregunta nada si solo puede atender una persona", async () => {
  const ctx = await contexto(
    crearTenant({
      empleados: [
        { id: "ana", nombre: "Ana", activo: true, serviciosIds: ["lavado-basico"] },
        { id: "marco", nombre: "Marco", activo: true, serviciosIds: ["pulido"] },
      ],
    }),
  );
  const { r, interactivo } = await correr(ctx, "ofrecer_empleados", { servicioId: "pulido" });
  assert.equal(r.ok, false, "no hay nada que elegir");
  assert.equal(r.empleadoId, "marco");
  assert.equal(interactivo, undefined, "no se le manda ninguna lista al cliente");
});

test("ofrecer_empleados avisa que no aplica si el negocio no tiene equipo", async () => {
  const ctx = await contexto(crearTenant());
  const { r } = await correr(ctx, "ofrecer_empleados", { servicioId: "lavado-basico" });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no tiene equipo/);
});

test("ofrecer_horarios con empleadoId solo lista los horarios de esa persona", async () => {
  const ctx = await contexto(crearTenant({ empleados: EQUIPO }));
  await correr(ctx, "agendar_cita", agendar({ empleadoId: "ana", hora: "09:00" }));
  const { interactivo } = await correr(ctx, "ofrecer_horarios", {
    fecha: LUNES,
    servicioId: "lavado-basico",
    empleadoId: "ana",
  });
  const ids = interactivo?.opciones.map((o) => o.id) ?? [];
  assert.ok(!ids.includes(`slot|${LUNES}|09:00|ana`), "09:00 ya lo tiene ocupado");
  assert.ok(ids.includes(`slot|${LUNES}|09:30|ana`));
  // El id lleva la persona para que el tap no pierda la elección.
  assert.ok(ids.every((id) => id.endsWith("|ana")));
});

test("ofrecer_horarios sin empleadoId preasigna a alguien libre en cada horario", async () => {
  const ctx = await contexto(crearTenant({ empleados: EQUIPO }));
  await correr(ctx, "agendar_cita", agendar({ empleadoId: "ana", hora: "09:00" }));
  const { interactivo } = await correr(ctx, "ofrecer_horarios", { fecha: LUNES, servicioId: "lavado-basico" });
  const nueve = interactivo?.opciones.find((o) => o.id.startsWith(`slot|${LUNES}|09:00`));
  assert.equal(nueve?.id, `slot|${LUNES}|09:00|marco`, "a las 09:00 solo queda Marco");
  assert.equal(nueve?.descripcion, "Con Marco");
});

test("reprogramar_cita mueve la cita CON su persona y respeta sus choques", async () => {
  const ctx = await contexto(crearTenant({ empleados: EQUIPO }));
  await correr(ctx, "agendar_cita", agendar({ empleadoId: "ana", hora: "09:00" }));
  // Ana también tiene las 11:00 con otro cliente.
  await ctx.repo.crearCita({
    tenantId: ctx.tenant.id,
    clienteWa: "50611112222",
    clienteNombre: "Otro",
    servicioId: "lavado-basico",
    empleadoId: "ana",
    fecha: LUNES,
    hora: "11:00",
  });

  const choque = await correr(ctx, "reprogramar_cita", { fecha: LUNES, hora: "11:00" });
  assert.equal(choque.r.ok, false);
  assert.match(choque.r.motivo, /Ana/);

  const ok = await correr(ctx, "reprogramar_cita", { fecha: LUNES, hora: "14:00" });
  assert.equal(ok.r.ok, true);
  assert.equal(ok.r.cita.hora, "14:00");
  const citas = await ctx.repo.citasPorFecha(ctx.tenant.id, LUNES);
  assert.equal(citas.find((c) => c.hora === "14:00")?.empleadoId, "ana", "conserva a Ana");
});

test("no se le puede agendar a alguien un servicio que no hace", async () => {
  const ctx = await contexto(
    crearTenant({
      empleados: [
        { id: "ana", nombre: "Ana", activo: true, serviciosIds: ["lavado-basico"] },
        { id: "marco", nombre: "Marco", activo: true },
      ],
    }),
  );
  const { r } = await correr(ctx, "agendar_cita", agendar({ servicioId: "pulido", empleadoId: "ana" }));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no tiene libre ese horario/);
});

test("no se le puede agendar a alguien inactivo", async () => {
  const ctx = await contexto(
    crearTenant({
      empleados: [
        { id: "ana", nombre: "Ana", activo: true },
        { id: "marco", nombre: "Marco", activo: false },
      ],
    }),
  );
  const { r } = await correr(ctx, "agendar_cita", agendar({ empleadoId: "marco" }));
  assert.equal(r.ok, false);
  // Existe (por eso no es "no existe nadie"), pero no está disponible para citas nuevas.
  assert.match(r.motivo, /no tiene libre ese horario/);
});
