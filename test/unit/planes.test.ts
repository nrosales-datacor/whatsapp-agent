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
