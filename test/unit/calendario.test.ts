import assert from "node:assert/strict";
import { test } from "node:test";
import { calendarioConfigurado, calendarioDeTenant } from "../../src/calendar/googleCalendar";
import { crearTenant } from "../helpers/fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Aislamiento del Google Calendar por negocio (auditoría BLOQ-05).
//
// El bug original: `GOOGLE_CALENDAR_ID` era una env GLOBAL y `crearEventoCita`
// recibía el tenant pero lo ignoraba para elegir el calendario. Con dos clientes,
// las citas de la barbería (con nombre, teléfono, servicio y precio del cliente
// final) se escribían en el Google Calendar del lavacar, y una cancelación podía
// borrar eventos ajenos. Estos tests fijan la regla: el calendario sale del tenant,
// y un tenant sin calendario propio queda APAGADO, nunca redirigido a otro.
// ─────────────────────────────────────────────────────────────────────────────

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

const CREDENCIALES = {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "bot@proyecto.iam.gserviceaccount.com",
  GOOGLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----falsa-----END PRIVATE KEY-----",
};

test("calendarioDeTenant: usa el calendario del propio negocio", () => {
  const tenant = crearTenant({ id: "barberia", googleCalendarId: "barberia@gmail.com" });
  conEnv({ ...CREDENCIALES, GOOGLE_CALENDAR_ID: undefined, GOOGLE_CALENDAR_TENANT_ID: undefined }, () => {
    assert.equal(calendarioDeTenant(tenant), "barberia@gmail.com");
    assert.equal(calendarioConfigurado(tenant), true);
  });
});

test("calendarioDeTenant: un tenant sin calendario propio NO cae al de otro negocio", () => {
  const otro = crearTenant({ id: "barberia", googleCalendarId: undefined });
  // El .env tiene el calendario del piloto ("lavacar"), no el de este negocio.
  conEnv(
    { ...CREDENCIALES, GOOGLE_CALENDAR_ID: "lavacar@gmail.com", GOOGLE_CALENDAR_TENANT_ID: "lavacar" },
    () => {
      assert.equal(calendarioDeTenant(otro), null);
      assert.equal(calendarioConfigurado(otro), false); // apagado, no redirigido
    },
  );
});

test("calendarioDeTenant: el fallback del .env solo aplica al tenant nombrado", () => {
  const piloto = crearTenant({ id: "lavacar", googleCalendarId: undefined });
  conEnv(
    { ...CREDENCIALES, GOOGLE_CALENDAR_ID: "lavacar@gmail.com", GOOGLE_CALENDAR_TENANT_ID: "lavacar" },
    () => {
      assert.equal(calendarioDeTenant(piloto), "lavacar@gmail.com");
    },
  );
});

test("calendarioDeTenant: sin GOOGLE_CALENDAR_TENANT_ID el .env no aplica a nadie", () => {
  const piloto = crearTenant({ id: "lavacar", googleCalendarId: undefined });
  conEnv(
    { ...CREDENCIALES, GOOGLE_CALENDAR_ID: "lavacar@gmail.com", GOOGLE_CALENDAR_TENANT_ID: undefined },
    () => {
      assert.equal(calendarioDeTenant(piloto), null);
    },
  );
});

test("calendarioDeTenant: la columna del tenant le gana al .env", () => {
  const piloto = crearTenant({ id: "lavacar", googleCalendarId: "nuevo@group.calendar.google.com" });
  conEnv(
    { ...CREDENCIALES, GOOGLE_CALENDAR_ID: "viejo@gmail.com", GOOGLE_CALENDAR_TENANT_ID: "lavacar" },
    () => {
      assert.equal(calendarioDeTenant(piloto), "nuevo@group.calendar.google.com");
    },
  );
});

test("calendarioConfigurado: sin credenciales de la service account queda apagado", () => {
  const tenant = crearTenant({ googleCalendarId: "barberia@gmail.com" });
  conEnv({ GOOGLE_SERVICE_ACCOUNT_EMAIL: undefined, GOOGLE_PRIVATE_KEY: undefined }, () => {
    assert.equal(calendarioConfigurado(tenant), false);
  });
});
