import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Importar y exportar clientes en CSV (I3) por HTTP, con la app real sobre PGlite:
//   • Importar: encabezados detectados y mapeo sugerido, comillas, BOM, separador `;`,
//     teléfono normalizado y dedupe (en el archivo y contra la base), errores por fila,
//     vista previa sin escribir, importar en una transacción, actualizar sin borrar,
//     omitir existentes, campos personalizados, mapeo propio y sus errores, auditoría.
//   • Exportar: BOM, encabezados (con los campos personalizados), filtros, estado, escape
//     de fórmulas, y que el archivo exportado se pueda volver a importar.
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-clients-import-session-secret-0123456789";
process.env.TOKENS_ENCRYPTION_KEY = "a".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "500";

const { createAppHandler } = await import("../../src/app");
const { clients } = await import("../../src/modules/clients/schema");
const { listTenantAudit } = await import("../../src/platform/audit/auditLog");
const { withTenant } = await import("../../src/platform/db/scope");
const { parseCsv } = await import("../../src/modules/clients/csv");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { startTestServer } = await import("../helpers/panelClient");
const { createCrmTeam, insertClient } = await import("../helpers/crmFixtures");

type TestServer = Awaited<ReturnType<typeof startTestServer>>;
type Team = Awaited<ReturnType<typeof createCrmTeam>>;

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

const BOM = "﻿";

async function clientsOf(businessId: string) {
  const rows = await withTenant(db, businessId, (tx) => tx.select().from(clients).where(eq(clients.businessId, businessId)));
  return rows.sort((a, b) => a.name.localeCompare(b.name, "es"));
}

const importCsv = (t: Team, body: Record<string, unknown>) => t.owner.post("/api/panel/clients/import", body);

test("vista previa: encabezados, mapeo sugerido, comillas, BOM, dedupe y errores por fila — sin escribir", async () => {
  const t = await createCrmTeam(db, app.baseUrl);
  await t.owner.post("/api/panel/settings/custom-fields", { entity: "client", label: "Tipo de piel", type: "select", options: ["Seca", "Grasa"] });
  await insertClient(db, t.businessId, { name: "Ya Existía", phone: "+50688880001", tags: ["Antigua"] });
  const csv =
    `${BOM}Nombre;Celular;Correo electrónico;Fecha de nacimiento;Etiquetas;Tipo de piel;Columna rara\r\n` +
    `"Fernández; María";8888-0001;maria@example.com;17/05/1990;"VIP, Frecuente";grasa;x\r\n` +
    `Luis Mora;+506 7000 1234;;1985-01-02;;;\r\n` +
    `Repetido;7000-1234;;;;;\r\n` +
    `Mal Teléfono;12;no-es-correo;31/02/1990;;Normal;\r\n` +
    `;6000 0000;;;;;\r\n` +
    `"Nota con ""comillas""";;;;;;\r\n`;

  const res = await importCsv(t, { csv });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const r = res.body.data;
  assert.equal(r.committed, false);
  assert.equal(r.delimiter, ";");
  assert.equal(r.hasHeader, true);
  assert.deepEqual(r.columns.map((c: { header: string }) => c.header), ["Nombre", "Celular", "Correo electrónico", "Fecha de nacimiento", "Etiquetas", "Tipo de piel", "Columna rara"]);
  assert.deepEqual(r.mapping, { 0: "name", 1: "phone", 2: "email", 3: "birth_date", 4: "tags", 5: "custom:tipo_de_piel", 6: null });
  assert.ok(r.fields.some((f: { id: string; label: string }) => f.id === "custom:tipo_de_piel" && f.label === "Tipo de piel"));
  assert.deepEqual(r.summary, { create: 2, update: 1, skip: 0, error: 3 });
  assert.deepEqual(
    r.preview.map((p: { row: number; action: string; name: string | null; phone: string | null }) => [p.row, p.action, p.name, p.phone]),
    [
      [2, "update", "Fernández; María", "+50688880001"],
      [3, "create", "Luis Mora", "+50670001234"],
      [4, "error", "Repetido", "+50670001234"],
      [5, "error", "Mal Teléfono", null],
      [6, "error", null, "+50660000000"],
      [7, "create", 'Nota con "comillas"', null],
    ],
  );
  const errorsByRow = Object.fromEntries(r.errors.map((e: { row: number; messages: string[] }) => [e.row, e.messages.join(" | ")]));
  assert.match(errorsByRow[4], /repetido en el archivo \(ya está en la fila 3\)/);
  assert.match(errorsByRow[5], /Teléfono inválido/);
  assert.match(errorsByRow[5], /Correo inválido/);
  assert.match(errorsByRow[5], /Fecha de nacimiento inválida/);
  assert.match(errorsByRow[5], /Tipo de piel: «Normal» no es una de las opciones/);
  assert.match(errorsByRow[6], /Falta el nombre/);

  assert.equal((await clientsOf(t.businessId)).length, 1, "la vista previa no escribe nada");
});

test("importar: crea y actualiza en una transacción; actualizar suma etiquetas y no borra con celdas vacías; queda auditado", async () => {
  const t = await createCrmTeam(db, app.baseUrl);
  await t.owner.post("/api/panel/settings/custom-fields", { entity: "client", label: "Tipo de piel", type: "select", options: ["Seca", "Grasa"] });
  const existing = await insertClient(db, t.businessId, { name: "Sin nombre", phone: "+50688880001", email: "vieja@example.com", tags: ["Antigua"], notes: "No borrar" });
  const csv = [
    "Nombre,Apellidos,Teléfono,Correo,Etiquetas,Notas,Tipo de piel",
    "María,Fernández,8888-0001,,VIP,,Grasa",
    "Luis,Mora,7000-1234,luis@example.com,Frecuente;Referido,Llega tarde,Seca",
    "Sin,Teléfono,,,,,",
    "Error,Fila,123,,,,",
  ].join("\n");

  const res = await importCsv(t, { csv, commit: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.committed, true);
  assert.deepEqual(res.body.data.mapping, { 0: "first_name", 1: "last_name", 2: "phone", 3: "email", 4: "tags", 5: "notes", 6: "custom:tipo_de_piel" }, "Nombre + Apellidos");
  assert.deepEqual(res.body.data.summary, { create: 2, update: 1, skip: 0, error: 1 });

  const rows = await clientsOf(t.businessId);
  assert.deepEqual(
    rows.map((c) => [c.name, c.phone, c.email, c.tags, c.notes, c.source, c.customData]),
    [
      ["Luis Mora", "+50670001234", "luis@example.com", ["Frecuente", "Referido"], "Llega tarde", "Importación", { tipo_de_piel: "Seca" }],
      ["María Fernández", "+50688880001", "vieja@example.com", ["Antigua", "VIP"], "No borrar", null, { tipo_de_piel: "Grasa" }],
      ["Sin Teléfono", null, null, [], null, "Importación", {}],
    ],
  );
  assert.equal(rows.find((c) => c.phone === "+50688880001")?.id, existing, "es el mismo cliente, actualizado");

  const audit = await listTenantAudit(db, t.businessId);
  const entry = audit.find((a) => a.action === "clients_imported");
  assert.ok(entry, "queda en audit_log");
  assert.deepEqual(entry.details, { created: 2, updated: 1, skipped: 0, errors: 1 });
  assert.equal(JSON.stringify(entry.details).includes("+506"), false, "sin datos personales en el rastro");

  // Repetir el mismo archivo: nada nuevo (dedupe por teléfono; el sin teléfono se crea otra vez).
  const again = await importCsv(t, { csv, commit: true });
  assert.deepEqual(again.body.data.summary, { create: 1, update: 2, skip: 0, error: 1 });
});

test("importar: omitir existentes, sin encabezados con mapeo propio, y errores del mapeo", async () => {
  const t = await createCrmTeam(db, app.baseUrl);
  await insertClient(db, t.businessId, { name: "Original", phone: "+50688880002" });
  const csv = "Otra Persona,8888 0002\nNueva Persona,8888 0003\n";

  const preview = await importCsv(t, { csv });
  assert.equal(preview.body.data.hasHeader, false, "la primera fila tiene un teléfono: son datos");
  assert.deepEqual(preview.body.data.mapping, { 0: null, 1: null }, "sin encabezados no hay sugerencia");
  const noName = await importCsv(t, { csv, mapping: { 0: null, 1: null } });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.code, "import_mapping_incomplete");
  const dup = await importCsv(t, { csv, mapping: { 0: "name", 1: "name" } });
  assert.equal(dup.status, 400);
  assert.ok(dup.body.fields["body.mapping.1"]);
  const unknown = await importCsv(t, { csv, mapping: { 0: "name", 1: "custom:no_existe", 7: "email" } });
  assert.equal(unknown.status, 400);
  assert.ok(unknown.body.fields["body.mapping.1"]);
  assert.ok(unknown.body.fields["body.mapping.7"], "columna inexistente");

  const res = await importCsv(t, { csv, hasHeader: false, mapping: { 0: "name", 1: "phone" }, onExisting: "skip", commit: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.summary, { create: 1, update: 0, skip: 1, error: 0 });
  assert.deepEqual((await clientsOf(t.businessId)).map((c) => c.name), ["Nueva Persona", "Original"], "el existente quedó como estaba");
});

test("importar: archivo vacío, comilla sin cerrar o demasiado grande → 400 claro", async () => {
  const t = await createCrmTeam(db, app.baseUrl);
  const empty = await importCsv(t, { csv: "\n\n" });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, "invalid_csv");
  const unclosed = await importCsv(t, { csv: 'Nombre\n"Ana' });
  assert.equal(unclosed.status, 400);
  assert.match(unclosed.body.error, /comilla sin cerrar/);
  const many = await importCsv(t, { csv: `Nombre\n${Array.from({ length: 5001 }, (_, i) => `Cliente ${i}`).join("\n")}` });
  assert.equal(many.status, 400);
  assert.match(many.body.error, /demasiadas filas|más de 5000/);
});

test("exportar: BOM, encabezados con campos personalizados, filtros, estado y escape de fórmulas; se vuelve a importar", async () => {
  const t = await createCrmTeam(db, app.baseUrl);
  await t.owner.post("/api/panel/settings/custom-fields", { entity: "client", label: "Tipo de piel", type: "select", options: ["Seca", "Grasa"] });
  await t.owner.post("/api/panel/settings/custom-fields", { entity: "client", label: "Embarazada", type: "boolean" });
  await insertClient(db, t.businessId, {
    name: "=CMD() Peligrosa",
    phone: "+50688880011",
    email: "p@example.com",
    tags: ["VIP", "Frecuente"],
    notes: "Línea 1\nLínea, 2",
    visitCount: 12,
    firstVisitAt: new Date("2025-01-10T15:00:00Z"),
    lastVisitAt: new Date(Date.now() - 3 * 86_400_000),
    totalSpentCents: 1_234_567,
    customData: { tipo_de_piel: "Grasa", embarazada: false },
    preferredStaffId: t.staffIds[0],
  });
  await insertClient(db, t.businessId, { name: "Beatriz Común", phone: "+50688880012" });

  const res = await t.owner.getText("/api/panel/clients/export.csv");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/csv; charset=utf-8/);
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="clientes-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.ok(res.text.startsWith(BOM), "con BOM para Excel");
  const { rows } = parseCsv(res.text);
  const [header, ...data] = rows;
  assert.deepEqual(header.slice(0, 3), ["Nombre", "Teléfono", "Correo"]);
  assert.deepEqual(header.slice(-2), ["Tipo de piel", "Embarazada"]);
  const col = (name: string) => header.indexOf(name);
  assert.equal(data.length, 2);
  const risky = data.find((r) => r[col("Teléfono")] === "+50688880011") as string[];
  assert.equal(risky[col("Nombre")], "'=CMD() Peligrosa", "la fórmula no se ejecuta en la planilla");
  assert.equal(risky[col("Notas")], "Línea 1\nLínea, 2");
  assert.equal(risky[col("Etiquetas")], "VIP; Frecuente");
  assert.equal(risky[col("Estado")], "VIP");
  assert.equal(risky[col("VIP")], "Sí");
  assert.equal(risky[col("Visitas")], "12");
  assert.equal(risky[col("Gasto total (CRC)")], "12345.67");
  assert.equal(risky[col("Profesional preferido")], "Ana Rojas");
  assert.equal(risky[col("Tipo de piel")], "Grasa");
  assert.equal(risky[col("Embarazada")], "No");

  // Con filtros: solo los VIP.
  const vip = parseCsv((await t.owner.getText("/api/panel/clients/export.csv?vip=true")).text).rows;
  assert.equal(vip.length, 2, "encabezados + 1");

  // Ida y vuelta: el archivo exportado se reconoce y actualiza a los mismos clientes.
  const back = await importCsv(t, { csv: res.text });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.data.hasHeader, true);
  assert.equal(back.body.data.mapping[String(col("Tipo de piel"))], "custom:tipo_de_piel");
  assert.equal(back.body.data.mapping[String(col("Embarazada"))], "custom:embarazada");
  assert.deepEqual(back.body.data.summary, { create: 0, update: 2, skip: 0, error: 0 });
  const committed = await importCsv(t, { csv: res.text, commit: true });
  assert.equal(committed.status, 200);
  const [peligrosa] = await withTenant(db, t.businessId, (tx) =>
    tx
      .select()
      .from(clients)
      .where(and(eq(clients.businessId, t.businessId), eq(clients.phone, "+50688880011"))),
  );
  assert.equal(peligrosa.name, "=CMD() Peligrosa", "el apóstrofo del escape se quita al importar");
  assert.deepEqual(peligrosa.tags, ["VIP", "Frecuente"]);
  assert.deepEqual(peligrosa.customData, { tipo_de_piel: "Grasa", embarazada: false });
});
