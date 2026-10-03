import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { construirMensajeFecha, construirSystemPrompt } from "../../src/agent/systemPrompt";
import { crearTenant } from "../helpers/fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Caché de prompts de OpenAI (revisión pre-venta 2026-10). OpenAI cachea solo el
// PREFIJO idéntico de la request: si el system prompt cambia cada minuto (la hora iba
// en las primeras líneas), la base de conocimiento nunca pega en el caché. Acá se
// verifica que el prompt del tenant es idéntico a minutos distintos y que lo que sí
// cambia (la fecha/hora) vive en un mensaje aparte.
// ─────────────────────────────────────────────────────────────────────────────

function tenantConKb() {
  return crearTenant({
    kb: {
      faq: [{ pregunta: "¿Hacen lavado de motor?", respuesta: "Sí, con cita." }],
      datos: ["Parqueo propio"],
      politicas: ["Se cobra al entregar el vehículo"],
      secciones: [{ id: "precios", titulo: "Precios", items: ["Lavado básico ₡5.000", "Pulido ₡25.000"] }],
    },
  });
}

test("construirSystemPrompt: idéntico a minutos (y días) distintos — el prefijo cacheable no depende de la hora", () => {
  const tenant = tenantConKb();
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-02T15:03:00Z") });
  try {
    const a = construirSystemPrompt(tenant);
    mock.timers.setTime(new Date("2026-10-02T15:41:00Z").getTime());
    const b = construirSystemPrompt(tenant);
    mock.timers.setTime(new Date("2027-01-15T09:00:00Z").getTime());
    const c = construirSystemPrompt(tenant);
    assert.equal(a, b);
    assert.equal(a, c);
    assert.doesNotMatch(a, /Ahora mismo es/);
    assert.doesNotMatch(a, /2026/);
  } finally {
    mock.timers.reset();
  }
});

test("construirMensajeFecha: lleva la fecha/hora de la zona del tenant y cambia con el minuto", () => {
  const tenant = tenantConKb();
  const a = construirMensajeFecha(tenant, new Date("2026-10-02T15:03:00Z")); // 09:03 en Costa Rica
  const b = construirMensajeFecha(tenant, new Date("2026-10-02T15:41:00Z")); // 09:41
  assert.notEqual(a, b);
  assert.match(a, /Hoy es 2026-10-02/);
  assert.match(a, /09:03/);
  assert.match(a, /America\/Costa_Rica/);
  assert.match(a, /año actual \(2026\)/); // hay servicios agendables → la regla del año
});

test("construirSystemPrompt: con upsell (plan Pro) lista el add-on con su id; sin Pro, no", () => {
  const servicios = [
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
  ];
  const pro = construirSystemPrompt(crearTenant({ plan: "pro", servicios }));
  assert.match(pro, /add-on al agendarlo: Aplicación de flúor \(addonId: fluor, ₡8/); // moneda "CRC" se formatea con su símbolo (E11)
  const basico = construirSystemPrompt(crearTenant({ plan: "basico", servicios }));
  assert.doesNotMatch(basico, /addonId: fluor/);
});
