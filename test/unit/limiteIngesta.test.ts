import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { _resetParaTests, permitirIngesta } from "../../src/red/limiteIngesta";

// ─────────────────────────────────────────────────────────────────────────────
// F10 — token bucket en memoria del rate limit de ingesta por tenant. Solo se
// prueba el burst (capacidad inicial): no se testea el refill dependiente del
// reloj real para evitar un test lento/flaky con sleeps — el cálculo de refill
// es una línea (`tokens + segTranscurridos * recarga`, capado a `capacidad`),
// de riesgo bajo comparado con el comportamiento de negocio (agotar el burst).
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => _resetParaTests());

test("dentro del burst, todos los mensajes se permiten", () => {
  // Default de RATE_LIMIT_INGESTA_BASICO_CAPACIDAD = 20 (ver src/red/limiteIngesta.ts).
  for (let i = 0; i < 20; i++) {
    assert.equal(permitirIngesta("tenant-burst", "basico"), true, `mensaje ${i + 1} debía entrar dentro del burst`);
  }
});

test("agotado el burst, el siguiente mensaje se rechaza (debe diferirse, no perderse)", () => {
  for (let i = 0; i < 20; i++) permitirIngesta("tenant-agotado", "basico");
  assert.equal(permitirIngesta("tenant-agotado", "basico"), false, "el 21º mensaje excede el burst");
});

test("el límite es POR TENANT: agotar el burst de uno no afecta a otro", () => {
  for (let i = 0; i < 20; i++) permitirIngesta("tenant-a", "basico");
  assert.equal(permitirIngesta("tenant-a", "basico"), false);
  assert.equal(permitirIngesta("tenant-b", "basico"), true, "otro tenant debe tener su propio balde lleno");
});

test("plan pro tiene más margen que básico (mismo criterio: no afecta a los tenants que sí tienen volumen legítimo)", () => {
  // Default de RATE_LIMIT_INGESTA_PRO_CAPACIDAD = 60.
  for (let i = 0; i < 20; i++) assert.equal(permitirIngesta("tenant-pro", "pro"), true);
  // Un básico ya se hubiera agotado acá (capacidad 20); un pro todavía tiene margen.
  assert.equal(permitirIngesta("tenant-pro", "pro"), true, "el plan pro debe seguir permitiendo tras 20 mensajes");
});
