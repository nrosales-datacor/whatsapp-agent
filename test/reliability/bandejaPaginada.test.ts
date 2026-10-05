import assert from "node:assert/strict";
import { test } from "node:test";
import { repoDePrueba } from "../helpers/repoDePrueba";

// ─────────────────────────────────────────────────────────────────────────────
// Bandeja paginada (escala del panel): el listado sale del índice
// (tenant_id, ultima_actividad_en) que mantiene un trigger sobre wa_mensajes, de a páginas,
// con búsqueda en el servidor; y la lectura liviana para responder no carga el historial.
// ─────────────────────────────────────────────────────────────────────────────

const T = "tenant-bandeja";
const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function sembrar(repo: Awaited<ReturnType<typeof repoDePrueba>>, clientes: string[]) {
  const ids: string[] = [];
  for (const tel of clientes) {
    const c = await repo.obtenerOConversacion(T, tel);
    await repo.guardarMensaje(T, c.id, { rol: "user", contenido: `hola de ${tel}`, creadoEn: new Date().toISOString() });
    ids.push(c.id);
    await dormir(5); // actividad estrictamente creciente
  }
  return ids;
}

test("bandeja: un mensaje nuevo sube la conversación al tope (trigger de última actividad)", async () => {
  const repo = await repoDePrueba();
  const [a, b] = await sembrar(repo, ["50610000001", "50610000002"]);
  assert.deepEqual((await repo.listarConversaciones(T)).map((c) => c.id), [b, a]);
  await repo.guardarMensaje(T, a, { rol: "assistant", contenido: "respuesta", creadoEn: new Date().toISOString() });
  assert.deepEqual((await repo.listarConversaciones(T)).map((c) => c.id), [a, b]);
});

test("bandeja: limite + cursor antesDe recorren todo sin repetir ni saltear", async () => {
  const repo = await repoDePrueba();
  const ids = await sembrar(repo, ["50620000001", "50620000002", "50620000003", "50620000004", "50620000005"]);
  const pagina1 = await repo.listarConversaciones(T, { limite: 2 });
  assert.deepEqual(pagina1.map((c) => c.id), [ids[4], ids[3]]);
  const pagina2 = await repo.listarConversaciones(T, { limite: 2, antesDe: pagina1.at(-1)!.ultimaActividadEn! });
  assert.deepEqual(pagina2.map((c) => c.id), [ids[2], ids[1]]);
  const pagina3 = await repo.listarConversaciones(T, { limite: 2, antesDe: pagina2.at(-1)!.ultimaActividadEn! });
  assert.deepEqual(pagina3.map((c) => c.id), [ids[0]]);
});

test("bandeja: buscar encuentra por teléfono y por nombre de una cita, y toma % y _ literales", async () => {
  const repo = await repoDePrueba();
  const [conAna, otra] = await sembrar(repo, ["50630000001", "50630009999"]);
  await repo.crearCita({ tenantId: T, clienteWa: "50630000001", clienteNombre: "Ana Pérez", servicioId: "lavado", fecha: "2099-01-05", hora: "09:00" });
  assert.deepEqual((await repo.listarConversaciones(T, { buscar: "9999" })).map((c) => c.id), [otra]);
  assert.deepEqual((await repo.listarConversaciones(T, { buscar: "ana pé" })).map((c) => c.id), [conAna]);
  assert.deepEqual(await repo.listarConversaciones(T, { buscar: "%" }), [], "un % no es comodín");
  assert.deepEqual(await repo.listarConversaciones("otro-tenant", { buscar: "9999" }), [], "la búsqueda no cruza negocios");
});

test("bandeja: 'cita próxima' usa el hoy del negocio, no el de la base (UTC)", async () => {
  const repo = await repoDePrueba();
  const [conv] = await sembrar(repo, ["50640000001"]);
  await repo.crearCita({ tenantId: T, clienteWa: "50640000001", clienteNombre: "Luis", servicioId: "lavado", fecha: "2030-03-10", hora: "17:00" });
  // A las 19:00 de Costa Rica ya es el 11 en UTC: con el hoy del negocio la cita sigue vigente.
  const [res] = await repo.listarConversaciones(T, { hoy: "2030-03-10" });
  assert.equal(res.tieneCita, true);
  const [despues] = await repo.listarConversaciones(T, { hoy: "2030-03-11" });
  assert.equal(despues.tieneCita, false);
  const detalle = await repo.obtenerConversacionPorId(T, conv, { hoy: "2030-03-10" });
  assert.equal(detalle?.tieneCita, true);
});

test("estado liviano: ventana de 24 h desde el último mensaje del cliente, y nada de otro negocio", async () => {
  const repo = await repoDePrueba();
  const c = await repo.obtenerOConversacion(T, "50650000001");
  const sinMensajes = await repo.obtenerEstadoConversacion(T, c.id);
  assert.equal(sinMensajes?.ventanaAbierta, false);
  await repo.guardarMensaje(T, c.id, { rol: "user", contenido: "hola", creadoEn: new Date().toISOString() });
  await repo.guardarMensaje(T, c.id, { rol: "assistant", contenido: "¡hola!", creadoEn: new Date().toISOString() });
  const estado = await repo.obtenerEstadoConversacion(T, c.id);
  assert.equal(estado?.ventanaAbierta, true);
  assert.equal(estado?.clienteWa, "50650000001");
  assert.equal(estado?.modo, "bot");
  assert.equal(await repo.obtenerEstadoConversacion("otro-tenant", c.id), null);
});
