import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Campos personalizados y reglas de estado (I3) por HTTP, con la app real sobre PGlite:
//   • Definiciones: alta con clave desde el nombre, nombre repetido, opciones, tipos
//     compatibles, desactivar (lo cargado se conserva) y reactivar, orden.
//   • Valores en la ficha (PATCH /clients/:id) y en la cita (PATCH /appointments/:id):
//     tipo, opción, obligatorio, clave desconocida, vaciar; cambiar una definición no
//     rompe lo ya guardado.
//   • Reglas: GET con las del rubro, PUT validado, y el estado de la lista cambia con ellas.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-custom-fields-session-secret-0123456789";
process.env.TOKENS_ENCRYPTION_KEY = "e".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";

const { createAppHandler } = await import("../../src/app");
const { businesses } = await import("../../src/modules/business/schema");
const { clients } = await import("../../src/modules/clients/schema");
const { withTenant } = await import("../../src/platform/db/scope");
const { listConfigHistory } = await import("../../src/platform/audit/configHistory");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { startTestServer } = await import("../helpers/panelClient");
const { createCrmTeam, insertAppointment, insertClient } = await import("../helpers/crmFixtures");

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

const base = await createEphemeralDb();
const { db } = base;
let app: TestServer;

before(async () => {
  await base.client.exec("SET ROLE app_runtime");
  app = await startTestServer(createAppHandler({ db, role: "all" }));
});

after(async () => {
  await app?.close();
  await base.close();
});

const DAY = 86_400_000;

async function rowOf(businessId: string, id: string) {
  const [row] = await withTenant(db, businessId, (tx) => tx.select().from(clients).where(eq(clients.id, id)));
  return row;
}

test("definiciones: alta con clave desde el nombre, validaciones, tipos compatibles, desactivar y orden", async () => {
  const t = await createCrmTeam(db, app.baseUrl);
  const create = (body: Record<string, unknown>) => t.owner.post("/api/panel/settings/custom-fields", body);

  const skin = await create({ entity: "client", label: "Tipo de piel", type: "select", options: ["Seca", "Grasa", "seca", "Mixta"], required: true });
  assert.equal(skin.status, 201, JSON.stringify(skin.body));
  assert.equal(skin.body.data.key, "tipo_de_piel");
  assert.deepEqual(skin.body.data.options, ["Seca", "Grasa", "Mixta"], "opciones sin repetir");
  assert.equal(skin.body.data.required, true);

  const again = await create({ entity: "client", label: "tipo de piel", type: "text" });
  assert.equal(again.status, 400);
  assert.ok(again.body.fields["body.label"], "nombre repetido entre los activos");
  assert.ok((await create({ entity: "client", label: "Forma", type: "select", options: ["Una"] })).body.fields["body.options"], "al menos dos opciones");
  assert.ok((await create({ entity: "client", label: "Nota", type: "text", options: ["a", "b"] })).body.fields["body.options"], "opciones solo en select");
  assert.equal((await create({ entity: "cliente", label: "X", type: "text" })).status, 400);

  const allergies = (await create({ entity: "client", label: "Alergias", type: "text" })).body.data;
  const visits = (await create({ entity: "client", label: "Visitas previas", type: "number" })).body.data;
  const tooth = (await create({ entity: "appointment", label: "Pieza dental", type: "text" })).body.data;
  assert.equal(tooth.entity, "appointment");

  // Tipos: texto ↔ texto largo y opción → varias opciones, sí; el resto, no.
  const longText = await t.owner.patch(`/api/panel/settings/custom-fields/${allergies.id}`, { type: "long_text", label: "Alergias conocidas" });
  assert.equal(longText.status, 200, JSON.stringify(longText.body));
  assert.equal(longText.body.data.type, "long_text");
  assert.equal(longText.body.data.key, "alergias", "la clave no cambia al renombrar");
  const badType = await t.owner.patch(`/api/panel/settings/custom-fields/${visits.id}`, { type: "date" });
  assert.equal(badType.status, 400);
  assert.match(badType.body.fields["body.type"], /creá un campo nuevo/);

  // Desactivar ("borrar"): queda en la lista de dueño/admin, no en la de los formularios.
  const removed = await t.owner.delete(`/api/panel/settings/custom-fields/${visits.id}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.data.active, false);
  const active = await t.frontDesk.get("/api/panel/settings/custom-fields?entity=client&includeInactive=1");
  assert.deepEqual(active.body.data.map((f: { key: string }) => f.key), ["tipo_de_piel", "alergias"], "recepción no ve los desactivados");
  const all = await t.owner.get("/api/panel/settings/custom-fields?entity=client&includeInactive=1");
  assert.deepEqual(all.body.data.map((f: { key: string; active: boolean }) => [f.key, f.active]), [["tipo_de_piel", true], ["alergias", true], ["visitas_previas", false]]);

  // Una clave desactivada queda reservada: un campo nuevo con el mismo nombre lleva otra.
  const reborn = await create({ entity: "client", label: "Visitas previas", type: "text" });
  assert.equal(reborn.status, 201);
  assert.equal(reborn.body.data.key, "visitas_previas_2");
  const reactivate = await t.owner.patch(`/api/panel/settings/custom-fields/${visits.id}`, { active: true });
  assert.equal(reactivate.status, 400, "no puede haber dos activos con el mismo nombre");

  // Orden: tiene que traer todos (activos e inactivos) de la entidad.
  const ids = all.body.data.map((f: { id: string }) => f.id);
  assert.equal((await t.owner.put("/api/panel/settings/custom-fields/order", { entity: "client", ids })).status, 400);
  const reordered = await t.owner.put("/api/panel/settings/custom-fields/order", { entity: "client", ids: [reborn.body.data.id, ...ids].reverse() });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  assert.deepEqual(reordered.body.data.map((f: { key: string }) => f.key), ["visitas_previas", "alergias", "tipo_de_piel", "visitas_previas_2"]);

  // Cada cambio deja rastro en config_history.
  const history = await listConfigHistory(db, t.businessId, { entity: "custom_field" });
  assert.ok(history.length >= 5);
});

test("valores en la ficha: tipo, opción, obligatorio, clave desconocida, vaciar; y una definición que cambia no rompe lo guardado", async () => {
  const t = await createCrmTeam(db, app.baseUrl);
  const create = async (body: Record<string, unknown>) => (await t.owner.post("/api/panel/settings/custom-fields", body)).body.data;
  const skin = await create({ entity: "client", label: "Tipo de piel", type: "select", options: ["Seca", "Grasa", "Mixta"] });
  await create({ entity: "client", label: "Sesiones", type: "number" });
  await create({ entity: "client", label: "Última depilación", type: "date" });
  await create({ entity: "client", label: "Embarazada", type: "boolean" });
  await create({ entity: "client", label: "Zonas", type: "multi_select", options: ["Piernas", "Axilas", "Rostro"] });
  const clientId = await insertClient(db, t.businessId, { name: "Inés Campos" });
  const patch = (customData: Record<string, unknown>) => t.frontDesk.patch(`/api/panel/clients/${clientId}`, { customData });

  const bad = await patch({ tipo_de_piel: "Normal", sesiones: "tres", ultima_depilacion: "2026-02-30", embarazada: "no", zonas: ["Brazos"], color_favorito: "azul" });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.body.fields).sort(), [
    "body.customData.color_favorito",
    "body.customData.embarazada",
    "body.customData.sesiones",
    "body.customData.tipo_de_piel",
    "body.customData.ultima_depilacion",
    "body.customData.zonas",
  ]);

  const good = await patch({ tipo_de_piel: "Grasa", sesiones: 3, ultima_depilacion: "2026-09-30", embarazada: false, zonas: ["Rostro", "Piernas", "Rostro"] });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.deepEqual(good.body.data.customData, { tipo_de_piel: "Grasa", sesiones: 3, ultima_depilacion: "2026-09-30", embarazada: false, zonas: ["Piernas", "Rostro"] });

  // Vaciar una clave (null o "") la saca; las demás quedan como estaban.
  const cleared = await patch({ sesiones: null, tipo_de_piel: "" });
  assert.deepEqual(cleared.body.data.customData, { ultima_depilacion: "2026-09-30", embarazada: false, zonas: ["Piernas", "Rostro"] });

  // Obligatorio: si se manda customData, el obligatorio tiene que quedar cargado.
  await t.owner.patch(`/api/panel/settings/custom-fields/${skin.id}`, { required: true });
  const missing = await patch({ sesiones: 2 });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.fields["body.customData.tipo_de_piel"], "Campo obligatorio.");
  assert.equal((await t.frontDesk.patch(`/api/panel/clients/${clientId}`, { notes: "Sin tocar campos" })).status, 200, "editar otra cosa no exige los campos");
  assert.equal((await patch({ tipo_de_piel: "Seca", sesiones: 2 })).status, 200);

  // La definición cambia: se quita la opción guardada. Lo guardado se conserva y no traba
  // editar otras claves; escribir el valor viejo de nuevo, sí falla.
  await t.owner.patch(`/api/panel/settings/custom-fields/${skin.id}`, { options: ["Grasa", "Mixta"], required: false });
  assert.equal((await rowOf(t.businessId, clientId)).customData.tipo_de_piel, "Seca");
  const other = await patch({ sesiones: 4 });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.equal(other.body.data.customData.tipo_de_piel, "Seca");
  assert.equal((await patch({ tipo_de_piel: "Seca" })).status, 400);

  // Desactivar el campo: el valor sigue en la base (y vuelve al reactivarlo); mandarlo, no.
  await t.owner.delete(`/api/panel/settings/custom-fields/${skin.id}`);
  assert.equal((await patch({ tipo_de_piel: "Grasa" })).status, 400);
  assert.equal((await patch({ sesiones: 5 })).status, 200);
  assert.equal((await rowOf(t.businessId, clientId)).customData.tipo_de_piel, "Seca");
});

test("valores en la cita: PATCH /appointments/:id valida contra los campos de citas", async () => {
  const t = await createCrmTeam(db, app.baseUrl);
  await t.owner.post("/api/panel/settings/custom-fields", { entity: "appointment", label: "Pieza dental", type: "text", required: true });
  await t.owner.post("/api/panel/settings/custom-fields", { entity: "client", label: "Alergias", type: "text" });
  const clientId = await insertClient(db, t.businessId, { name: "Juan Pieza" });
  const appointmentId = await insertAppointment(db, t, { clientId, staffId: t.staffIds[0], startsAt: new Date(Date.now() + DAY), status: "confirmed" });
  const path = `/api/panel/appointments/${appointmentId}`;

  const wrongEntity = await t.frontDesk.patch(path, { customData: { alergias: "Látex" } });
  assert.equal(wrongEntity.status, 400, "un campo de cliente no va en la cita");
  assert.ok(wrongEntity.body.fields["body.customData.alergias"]);
  assert.ok(wrongEntity.body.fields["body.customData.pieza_dental"], "y el obligatorio de la cita falta");

  const ok = await t.frontDesk.patch(path, { customData: { pieza_dental: "16" }, notes: "Revisar" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.data.customData, { pieza_dental: "16" });
  assert.equal(ok.body.data.notes, "Revisar");
  // Solo notas: los campos quedan.
  const notes = await t.frontDesk.patch(path, { notes: "Listo" });
  assert.deepEqual(notes.body.data.customData, { pieza_dental: "16" });

  // En el Básico, los campos de la cita son del plan Pro.
  const basic = await createCrmTeam(db, app.baseUrl, { plan: "basic" });
  const bClient = await insertClient(db, basic.businessId, { name: "Básico" });
  const bAppt = await insertAppointment(db, basic, { clientId: bClient, staffId: basic.staffIds[0], startsAt: new Date(Date.now() + DAY), status: "confirmed" });
  const denied = await basic.frontDesk.patch(`/api/panel/appointments/${bAppt}`, { customData: { x: 1 } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "module_not_in_plan");
  assert.equal((await basic.frontDesk.patch(`/api/panel/appointments/${bAppt}`, { notes: "ok" })).status, 200);
});

test("reglas: GET trae las del rubro, PUT valida y guarda, y el estado de la lista cambia con ellas", async () => {
  const t = await createCrmTeam(db, app.baseUrl);
  await withTenant(db, t.businessId, (tx) => tx.update(businesses).set({ industry: "nails" }).where(eq(businesses.id, t.businessId)));
  const id = await insertClient(db, t.businessId, { name: "Karla", visitCount: 1, firstVisitAt: new Date(Date.now() - 40 * DAY), lastVisitAt: new Date(Date.now() - 40 * DAY) });

  const get = await t.admin.get("/api/panel/settings/client-rules");
  assert.equal(get.status, 200);
  assert.equal(get.body.data.industry, "nails");
  assert.equal(get.body.data.rules.newDays, 30, "sin cambios: los defaults");
  assert.equal(get.body.data.industryDefaults.atRiskMode, "frequency", "las del rubro, para restaurar");
  const statusOf = async () => (await t.owner.get(`/api/panel/clients/${id}`)).body.data.status;
  assert.equal(await statusOf(), "active");

  const rules = { ...get.body.data.rules, newDays: 45 };
  const put = await t.admin.put("/api/panel/settings/client-rules", rules);
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.data.rules.newDays, 45);
  assert.equal(await statusOf(), "new", "primera visita hace 40 días: con 45 sigue siendo nuevo");
  const stored = await withTenant(db, t.businessId, (tx) => tx.select({ r: businesses.clientStatusRules }).from(businesses).where(eq(businesses.id, t.businessId)));
  assert.deepEqual(stored[0].r, { newDays: 45 }, "se guarda solo lo que difiere de los defaults");

  const bad = await t.admin.put("/api/panel/settings/client-rules", { ...rules, atRiskAfterDays: 200, inactiveAfterDays: 100 });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fields["body.inactiveAfterDays"]);
  assert.equal((await t.admin.put("/api/panel/settings/client-rules", { newDays: 10 })).status, 400, "reglas completas");

  const atRisk = await t.admin.put("/api/panel/settings/client-rules", { ...rules, atRiskAfterDays: 30 });
  assert.equal(atRisk.status, 200);
  assert.equal(await statusOf(), "at_risk");
});
