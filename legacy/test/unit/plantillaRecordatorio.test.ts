import assert from "node:assert/strict";
import { test } from "node:test";
import { plantillaRecordatorioDeTenant } from "../../src/reminders/scheduler";
import { validarNombrePlantillaRecordatorio, validarPlantillaIdioma } from "../../src/config/validadores";
import { crearTenant } from "../helpers/fixtures";

// ─── Plantilla de recordatorio POR TENANT (E8 / AUDIT.md BLOQUEANTE-06) ──────
//
// El bug original: `process.env.WHATSAPP_TEMPLATE_RECORDATORIO` era una env GLOBAL,
// pero las plantillas de WhatsApp se aprueban POR WABA — o sea, por cliente. Con dos
// negocios, el nombre de plantilla aprobado en el WABA de uno NO existe en el del
// otro: Meta rechaza el envío y los recordatorios (la feature que más mira el dueño)
// funcionaban para UN solo cliente como máximo. Bloqueante para vender el segundo.
//
// Estos tests fijan la regla, espejo de calendario.test.ts (E4) y de las pruebas de
// `tokenDeTenant` en whatsappClient.test.ts (F5): la plantilla sale del tenant, la env
// global solo cubre al tenant nombrado explícitamente, y cualquier otro cae a texto
// libre — nunca hereda la plantilla de otro negocio.

/** Ejecuta `fn` con estas env y restaura las anteriores al terminar. */
function conEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previas = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(previas)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("plantillaRecordatorio: usa la plantilla propia del negocio cuando existe", () => {
  const tenant = crearTenant({ id: "barberia", plantillaRecordatorio: "recordatorio_barberia" });
  conEnv({ WHATSAPP_TEMPLATE_RECORDATORIO: undefined, WHATSAPP_TEMPLATE_TENANT_ID: undefined }, () => {
    assert.equal(plantillaRecordatorioDeTenant(tenant), "recordatorio_barberia");
  });
});

test("plantillaRecordatorio: la env global solo aplica al tenant nombrado (compat. piloto)", () => {
  const piloto = crearTenant({ id: "selyon", plantillaRecordatorio: undefined });
  conEnv(
    { WHATSAPP_TEMPLATE_RECORDATORIO: "recordatorio_legado", WHATSAPP_TEMPLATE_TENANT_ID: "selyon" },
    () => {
      assert.equal(plantillaRecordatorioDeTenant(piloto), "recordatorio_legado");
    },
  );
});

// El corazón de BLOQ-06: sin esto, el segundo cliente manda con el nombre de plantilla
// del primero y Meta se lo rechaza (o peor, si por casualidad existe, manda contenido ajeno).
test("plantillaRecordatorio: un tenant sin plantilla propia NUNCA hereda la de otro (fail-closed)", () => {
  const otro = crearTenant({ id: "barberia", plantillaRecordatorio: undefined });
  conEnv(
    { WHATSAPP_TEMPLATE_RECORDATORIO: "recordatorio_legado", WHATSAPP_TEMPLATE_TENANT_ID: "selyon" },
    () => {
      // null = cae a texto libre con botones, que es el camino seguro y ya existente.
      assert.equal(plantillaRecordatorioDeTenant(otro), null);
    },
  );
});

test("plantillaRecordatorio: sin WHATSAPP_TEMPLATE_TENANT_ID la env no aplica a nadie", () => {
  const piloto = crearTenant({ id: "selyon", plantillaRecordatorio: undefined });
  conEnv(
    { WHATSAPP_TEMPLATE_RECORDATORIO: "recordatorio_legado", WHATSAPP_TEMPLATE_TENANT_ID: undefined },
    () => {
      assert.equal(plantillaRecordatorioDeTenant(piloto), null);
    },
  );
});

test("plantillaRecordatorio: la plantilla propia le gana a la env global", () => {
  const piloto = crearTenant({ id: "selyon", plantillaRecordatorio: "recordatorio_nuevo" });
  conEnv(
    { WHATSAPP_TEMPLATE_RECORDATORIO: "recordatorio_legado", WHATSAPP_TEMPLATE_TENANT_ID: "selyon" },
    () => {
      assert.equal(plantillaRecordatorioDeTenant(piloto), "recordatorio_nuevo");
    },
  );
});

// ─── Validadores (E8) ────────────────────────────────────────────────────────

test("validarNombrePlantillaRecordatorio: normaliza a minúsculas y rechaza formatos inválidos", () => {
  assert.equal(validarNombrePlantillaRecordatorio("Recordatorio_Cita"), "recordatorio_cita");
  assert.equal(validarNombrePlantillaRecordatorio(""), ""); // vacío = sin configurar
  assert.equal(validarNombrePlantillaRecordatorio("con espacios"), null);
  assert.equal(validarNombrePlantillaRecordatorio("con-guion"), null); // Meta usa guion BAJO
});

test("validarPlantillaIdioma: acepta locales de Meta y rechaza el resto", () => {
  assert.equal(validarPlantillaIdioma("es"), "es");
  assert.equal(validarPlantillaIdioma("es_MX"), "es_MX");
  assert.equal(validarPlantillaIdioma("en_US"), "en_US");
  assert.equal(validarPlantillaIdioma(""), ""); // vacío = usa el default global
  assert.equal(validarPlantillaIdioma("es-MX"), null); // guion, no guion bajo
  assert.equal(validarPlantillaIdioma("espanol"), null);
  assert.equal(validarPlantillaIdioma("ES"), null); // el idioma va en minúscula
});
