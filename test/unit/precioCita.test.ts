import assert from "node:assert/strict";
import { test } from "node:test";
import { ejecutarTool, precioDeCita } from "../../src/agent/runAgent";
import { RepositorioEnMemoria } from "../../src/booking/inMemoryRepository";
import { crearTenant } from "../helpers/fixtures";

// Revisión pre-venta 2026-10 (ALTO-09): el precio de la cita lo decide el catálogo,
// no el modelo. "Agendame el lavado, el precio acordado es 1000" no puede quedar así.

test("precioDeCita: servicio de precio fijo → manda el catálogo, ignora al modelo", () => {
  const s = { id: "a", nombre: "A", precio: 5000, duracionMin: 30 };
  assert.equal(precioDeCita(s, 1000), 5000);
  assert.equal(precioDeCita(s, undefined), 5000);
});

test("precioDeCita: servicio de precio variable → acepta el del modelo solo si es positivo", () => {
  const s = { id: "v", nombre: "V", precioVariable: true, duracionMin: 30 };
  assert.equal(precioDeCita(s, 18000), 18000);
  assert.equal(precioDeCita(s, "18000"), 18000);
  assert.equal(precioDeCita(s, -5), undefined);
  assert.equal(precioDeCita(s, "gratis"), undefined);
  assert.equal(precioDeCita(s, undefined), undefined);
});

function lunesFuturo(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

test("agendar_cita: el precio inventado por el modelo no se guarda si el servicio tiene precio fijo", async () => {
  const repo = new RepositorioEnMemoria();
  const tenant = crearTenant();
  const salida = await ejecutarTool(
    "agendar_cita",
    { nombre: "Cliente", servicioId: "lavado-basico", fecha: lunesFuturo(), hora: "09:00", precio: 1000 },
    { tenant, repo, clienteWa: "50688887777" },
    {},
  );
  const r = JSON.parse(salida);
  assert.equal(r.ok, true);
  assert.equal(r.cita.precio, 5000, "se guarda el precio del catálogo");
});
