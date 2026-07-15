import assert from "node:assert/strict";
import { test } from "node:test";
import { tenantPuede } from "../../src/billing/planes";
import { crearTenant } from "../helpers/fixtures";

test("plan básico: no habilita campañas, multi-usuario ni white-label", () => {
  const tenant = crearTenant({ plan: "basico" });
  assert.equal(tenantPuede(tenant, "campanias"), false);
  assert.equal(tenantPuede(tenant, "multiUsuario"), false);
  assert.equal(tenantPuede(tenant, "whiteLabel"), false);
});

test("plan pro: habilita campañas, multi-usuario y white-label", () => {
  const tenant = crearTenant({ plan: "pro" });
  assert.equal(tenantPuede(tenant, "campanias"), true);
  assert.equal(tenantPuede(tenant, "multiUsuario"), true);
  assert.equal(tenantPuede(tenant, "whiteLabel"), true);
});

// Carril D (0.1): features de la Fase 1 (aún sin construir) ya quedan en el mapa,
// para gatearlas en el mismo commit que las construya sin tocar planes.ts de nuevo.
test("plan básico: tampoco habilita las features de la Fase 1 (rescate/upsell/reseñas)", () => {
  const tenant = crearTenant({ plan: "basico" });
  assert.equal(tenantPuede(tenant, "rescateCotizaciones"), false);
  assert.equal(tenantPuede(tenant, "upsell"), false);
  assert.equal(tenantPuede(tenant, "resenasPro"), false);
});

test("plan pro: habilita las features de la Fase 1 (rescate/upsell/reseñas)", () => {
  const tenant = crearTenant({ plan: "pro" });
  assert.equal(tenantPuede(tenant, "rescateCotizaciones"), true);
  assert.equal(tenantPuede(tenant, "upsell"), true);
  assert.equal(tenantPuede(tenant, "resenasPro"), true);
});
