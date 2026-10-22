import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Clientes de punta a punta por HTTP (I1), con la app real (createAppHandler) sobre PGlite
// corriendo como el rol de la app (`app_runtime`, SIN BYPASSRLS): alta y ficha, teléfono
// E.164 único por negocio, búsqueda y paginación por cursor, permisos por rol, derecho de
// supresión (que no queden datos personales) y aislamiento entre negocios.
//
// La env se fija ANTES de importar la app (rate limit y secreto de sesión se leen al cargar).
// ─────────────────────────────────────────────────────────────────────────────

process.env.TRUST_PROXY = "loopback";
process.env.PANEL_SESSION_SECRET = "test-clients-session-secret-0123456789";
process.env.TOKENS_ENCRYPTION_KEY = "c".repeat(64);
process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP = "200";

const { createAppHandler } = await import("../../src/app");
const { refreshClientStats } = await import("../../src/modules/clients");
const { clients } = await import("../../src/modules/clients/schema");
const { businesses } = await import("../../src/modules/business/schema");
type Terminology = import("../../src/modules/business").Terminology;
const { appointments } = await import("../../src/modules/scheduling/schema");
const { staff } = await import("../../src/modules/team/schema");
const { listTenantAudit } = await import("../../src/platform/audit/auditLog");
const { withTenant } = await import("../../src/platform/db/scope");
const { createEphemeralDb } = await import("../helpers/pgliteDb");
const { Browser, startTestServer } = await import("../helpers/panelClient");
const { createTestBusiness, createTestMember } = await import("../helpers/identityFixtures");

type TestServer = Awaited<ReturnType<typeof startTestServer>>;
type B = InstanceType<typeof Browser>;

const base = await createEphemeralDb();
const { db } = base;
let app: TestServer;

before(async () => {
  // Desde acá TODO (fixtures y requests) corre como el rol de la app.
  await base.client.exec("SET ROLE app_runtime");
  app = await startTestServer(createAppHandler({ db, role: "all" }));
});

after(async () => {
  await app?.close();
  await base.close();
});

async function loggedIn(email: string, password: string | null): Promise<B> {
  const b = new Browser(app.baseUrl);
  const res = await b.post("/api/panel/auth/login", { email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return b;
}

interface Team {
  businessId: string;
  locationIds: string[];
  staffIds: string[];
  owner: B;
  admin: B;
  frontDesk: B;
  staffMember: B;
}

/** Negocio con dos sucursales, dos profesionales y un usuario por rol (cada uno con su sesión). */
async function createTeam(options: { country?: string; terminology?: Record<string, string> } = {}): Promise<Team> {
  const biz = await createTestBusiness(db);
  const staffIds = await withTenant(db, biz.businessId, async (tx) => {
    await tx
      .update(businesses)
      .set({ country: options.country ?? "CR", terminology: (options.terminology ?? {}) as Partial<Terminology> })
      .where(eq(businesses.id, biz.businessId));
    const rows = await tx
      .insert(staff)
      .values([
        { businessId: biz.businessId, name: "Ana Rojas", position: 0 },
        { businessId: biz.businessId, name: "Beto Mora", position: 1, active: false },
      ])
      .returning({ id: staff.id });
    return rows.map((r) => r.id);
  });
  const member = async (role: "owner" | "admin" | "front_desk" | "staff") => {
    const m = await createTestMember(db, { businessId: biz.businessId, role });
    return loggedIn(m.email, m.password);
  };
  return {
    businessId: biz.businessId,
    locationIds: biz.locationIds,
    staffIds,
    owner: await member("owner"),
    admin: await member("admin"),
    frontDesk: await member("front_desk"),
    staffMember: await member("staff"),
  };
}

async function createClientVia(b: B, body: Record<string, unknown>) {
  const res = await b.post("/api/panel/clients", body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

/** Recorre todas las páginas de la lista y devuelve los nombres en orden. */
async function allPages(b: B, query: string, limit: number): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const qs: string = `${query}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res: { status: number; body: any } = await b.get(`/api/panel/clients?${qs}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.items.length <= limit);
    names.push(...res.body.data.items.map((c: { name: string }) => c.name));
    cursor = res.body.data.nextCursor;
    if (!cursor) return names;
  }
  throw new Error("la paginación no terminó");
}

// ─── Alta, ficha y normalización ────────────────────────────────────────────

test("alta y ficha: teléfono E.164 con el país del negocio, correo validado, etiquetas sin repetir", async () => {
  const t = await createTeam();
  const created = await createClientVia(t.frontDesk, {
    name: "  María Fernández ",
    phone: "8888-7777",
    email: "  Maria@Example.COM ",
    birthDate: "1990-05-17",
    notes: "Prefiere la tarde.",
    tags: ["VIP", "vip", " Frecuente "],
    preferredLocationId: t.locationIds[1],
    preferredStaffId: t.staffIds[0],
    preferredChannel: "email",
    source: "Instagram",
  });
  assert.equal(created.name, "María Fernández");
  assert.equal(created.phone, "+50688887777");
  assert.equal(created.email, "maria@example.com");
  assert.equal(created.birthDate, "1990-05-17");
  assert.deepEqual(created.tags, ["VIP", "Frecuente"]);
  assert.equal(created.preferredLocationId, t.locationIds[1]);
  assert.equal(created.preferredStaffId, t.staffIds[0]);
  assert.equal(created.preferredChannel, "email");
  assert.equal(created.source, "Instagram");
  assert.equal(created.visitCount, 0);
  assert.equal(created.anonymized, false);
  assert.equal("businessId" in created, false, "la vista no expone columnas internas");
  assert.deepEqual(created.customData, {});
  assert.equal(created.anonymizedAt, null);
  // Negocio Pro (CRM completo): la ficha trae el estado calculado.
  assert.equal(created.status, "new");
  assert.equal(created.isVip, false);

  const detail = await t.frontDesk.get(`/api/panel/clients/${created.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.data, { ...created, guardian: null, dependents: [] });

  // Otro país: el número local toma el código de Panamá.
  const pa = await createTeam({ country: "PA" });
  const panama = await createClientVia(pa.owner, { name: "Luis", phone: "6123-4567" });
  assert.equal(panama.phone, "+50761234567");
  // Sin teléfono ni correo también se puede (cliente de mostrador).
  const walkIn = await createClientVia(pa.owner, { name: "Sin datos", phone: "", email: "" });
  assert.equal(walkIn.phone, null);
  assert.equal(walkIn.email, null);
});

test("validación: teléfono, correo, fecha y nombre con errores por campo", async () => {
  const t = await createTeam();
  const res = await t.owner.post("/api/panel/clients", {
    name: "  ",
    phone: "8888-777",
    email: "no-es-correo",
    birthDate: "2999-01-01",
    preferredChannel: "sms",
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "validation_error");
  for (const key of ["body.name", "body.email", "body.birthDate", "body.preferredChannel"]) {
    assert.ok(res.body.fields[key], `${key}: ${JSON.stringify(res.body.fields)}`);
  }
  // El teléfono se valida con el país del negocio (después de la forma): su propio 400.
  const phone = await t.owner.post("/api/panel/clients", { name: "Ana", phone: "8888-777" });
  assert.equal(phone.status, 400);
  assert.match(phone.body.fields["body.phone"], /teléfono inválido/i);
  // Canal por correo sin correo cargado.
  const channel = await t.owner.post("/api/panel/clients", { name: "Ana", preferredChannel: "email" });
  assert.equal(channel.status, 400);
  assert.ok(channel.body.fields["body.preferredChannel"]);
});

test("teléfono único por negocio: 409 phone_taken al crear o editar; en otro negocio el mismo número sí entra", async () => {
  const t = await createTeam({ terminology: { client: "paciente", clients: "pacientes" } });
  const first = await createClientVia(t.owner, { name: "Laura Jiménez", phone: "+506 8888 1111" });
  const dup = await t.owner.post("/api/panel/clients", { name: "Otra", phone: "50688881111" });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "phone_taken");
  assert.match(dup.body.error, /paciente/, "con la terminología del negocio");
  assert.match(dup.body.error, /Laura Jiménez/, "dice quién lo tiene (mismo negocio)");

  const second = await createClientVia(t.owner, { name: "Sofía Castro", phone: "8888 2222" });
  const patch = await t.owner.patch(`/api/panel/clients/${second.id}`, { phone: "8888-1111" });
  assert.equal(patch.status, 409);
  assert.equal(patch.body.code, "phone_taken");
  // Volver a mandar su propio teléfono no choca consigo mismo.
  const same = await t.owner.patch(`/api/panel/clients/${second.id}`, { phone: "+50688882222", name: "Sofía C." });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.data.name, "Sofía C.");

  const other = await createTeam();
  const elsewhere = await createClientVia(other.owner, { name: "Laura en otro negocio", phone: "8888-1111" });
  assert.equal(elsewhere.phone, first.phone);
});

// ─── Búsqueda y paginación ──────────────────────────────────────────────────

test("búsqueda: nombre sin tildes ni mayúsculas, varias palabras, dígitos del teléfono y correo", async () => {
  const t = await createTeam();
  await createClientVia(t.owner, { name: "María Fernández", phone: "8888-0001", email: "maria@example.com" });
  await createClientVia(t.owner, { name: "Mario Ángel Vargas", phone: "8888-0002" });
  await createClientVia(t.owner, { name: "Laura Jiménez", phone: "7000-1234", email: "lau.j@correo.test" });
  await createClientVia(t.owner, { name: "Ana 100% Real_", phone: "6000-0000" });

  const search = async (q: string) => {
    const res = await t.frontDesk.get(`/api/panel/clients?q=${encodeURIComponent(q)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data.items.map((c: { name: string }) => c.name).sort((x: string, y: string) => x.localeCompare(y, "es"));
  };
  assert.deepEqual(await search("maria"), ["María Fernández"]);
  assert.deepEqual(await search("MARI"), ["María Fernández", "Mario Ángel Vargas"]);
  assert.deepEqual(await search("angel"), ["Mario Ángel Vargas"]);
  assert.deepEqual(await search("fernandez maría"), ["María Fernández"], "palabras en cualquier orden");
  assert.deepEqual(await search("7000-12"), ["Laura Jiménez"], "dígitos del teléfono, con guiones");
  assert.deepEqual(await search("+506 8888"), ["María Fernández", "Mario Ángel Vargas"]);
  assert.deepEqual(await search("lau.j@"), ["Laura Jiménez"], "parte del correo");
  assert.deepEqual(await search("100%"), ["Ana 100% Real_"], "los comodines de LIKE se escapan");
  assert.deepEqual(await search("%"), ["Ana 100% Real_"]);
  assert.deepEqual(await search("_"), ["Ana 100% Real_"]);
  assert.deepEqual(await search("nadie"), []);
});

test("paginación por cursor: por nombre (sin tildes) y por última visita, sin repetir ni saltear", async () => {
  const t = await createTeam();
  const names = ["Zoe", "ángela", "Bruno", "Álvaro", "carla", "Diego", "Bruno"];
  const ids: string[] = [];
  for (const name of names) ids.push((await createClientVia(t.owner, { name })).id);

  const byName = await allPages(t.owner, "sort=name", 3);
  assert.deepEqual(byName, ["Álvaro", "ángela", "Bruno", "Bruno", "carla", "Diego", "Zoe"]);

  // Última visita: las más recientes primero, las que nunca vinieron al final (por nombre).
  const day = (d: number) => new Date(Date.UTC(2026, 9, d, 15, 0, 0, 123));
  await refreshClientStats(db, t.businessId, ids[5], { visitCount: 3, firstVisitAt: day(1), lastVisitAt: day(10) }); // Diego
  await refreshClientStats(db, t.businessId, ids[0], { visitCount: 1, firstVisitAt: day(12), lastVisitAt: day(12) }); // Zoe
  await refreshClientStats(db, t.businessId, ids[2], { visitCount: 1, firstVisitAt: day(10), lastVisitAt: day(10) }); // Bruno (empata con Diego)
  const byVisit = await allPages(t.owner, "sort=last_visit", 2);
  assert.deepEqual(byVisit, ["Zoe", "Bruno", "Diego", "Álvaro", "ángela", "Bruno", "carla"]);

  const first = await t.owner.get("/api/panel/clients?sort=last_visit&limit=1");
  assert.equal(first.body.data.items[0].name, "Zoe");
  assert.equal(first.body.data.items[0].visitCount, 1);
  assert.equal(first.body.data.items[0].lastVisitAt, day(12).toISOString());

  // Cursores inválidos o de otro orden → 400 con el campo.
  const bad = await t.owner.get("/api/panel/clients?cursor=no-es-un-cursor");
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fields["query.cursor"]);
  const mixed = await t.owner.get(`/api/panel/clients?sort=name&cursor=${encodeURIComponent(first.body.data.nextCursor)}`);
  assert.equal(mixed.status, 400);
  const tooMany = await t.owner.get("/api/panel/clients?limit=500");
  assert.equal(tooMany.status, 400);
  assert.ok(tooMany.body.fields["query.limit"]);
});

// ─── Permisos ───────────────────────────────────────────────────────────────

test("permisos: todos leen (el profesional, solo sus clientes); owner, admin y front_desk crean y editan; staff no; solo owner anonimiza", async () => {
  const t = await createTeam();
  const c = await createClientVia(t.owner, { name: "Valeria Solís", phone: "8888-3333" });

  for (const b of [t.owner, t.admin, t.frontDesk, t.staffMember]) {
    assert.equal((await b.get("/api/panel/clients")).status, 200);
    assert.equal((await b.get("/api/panel/clients/form-options")).status, 200);
  }
  for (const b of [t.owner, t.admin, t.frontDesk]) assert.equal((await b.get(`/api/panel/clients/${c.id}`)).status, 200);
  // El profesional solo ve "Mis clientes" (con citas suyas): este no lo es (test/security/crmClients.test.ts).
  assert.equal((await t.staffMember.get(`/api/panel/clients/${c.id}`)).status, 404);
  for (const b of [t.admin, t.frontDesk]) {
    assert.equal((await b.patch(`/api/panel/clients/${c.id}`, { notes: "ok" })).status, 200);
    assert.equal((await b.post("/api/panel/clients", { name: `Nuevo ${randomUUID().slice(0, 4)}` })).status, 201);
  }

  const staffCreate = await t.staffMember.post("/api/panel/clients", { name: "No" });
  assert.equal(staffCreate.status, 403);
  assert.equal(staffCreate.body.code, "forbidden_role");
  assert.equal((await t.staffMember.patch(`/api/panel/clients/${c.id}`, { name: "No" })).status, 403);

  for (const b of [t.admin, t.frontDesk, t.staffMember]) {
    const res = await b.post(`/api/panel/clients/${c.id}/anonymize`, { confirmation: "8888-3333" });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "forbidden_role");
  }

  // Sin sesión: 401.
  assert.equal((await new Browser(app.baseUrl).get("/api/panel/clients")).status, 401);
});

// ─── Preferencias y responsable ─────────────────────────────────────────────

test("PATCH: sucursal y profesional del negocio, responsable de un menor y opciones de la ficha", async () => {
  const t = await createTeam();
  const other = await createTeam();
  const mom = await createClientVia(t.owner, { name: "Mamá", phone: "8888-4444" });
  const kid = await createClientVia(t.owner, { name: "Hija" });

  // Sucursal o profesional de OTRO negocio → 400 (la FK sola no lo frena: no ve RLS).
  const foreign = await t.owner.patch(`/api/panel/clients/${kid.id}`, {
    preferredLocationId: other.locationIds[0],
    preferredStaffId: other.staffIds[0],
  });
  assert.equal(foreign.status, 400);
  assert.ok(foreign.body.fields["body.preferredLocationId"]);
  assert.ok(foreign.body.fields["body.preferredStaffId"]);

  const ok = await t.owner.patch(`/api/panel/clients/${kid.id}`, {
    guardianId: mom.id,
    preferredLocationId: t.locationIds[0],
    preferredStaffId: t.staffIds[1],
    preferredChannel: "whatsapp",
    birthDate: "2015-03-02",
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.data.guardian, { id: mom.id, name: "Mamá" });
  assert.equal(ok.body.data.preferredStaffId, t.staffIds[1]);

  const momDetail = await t.owner.get(`/api/panel/clients/${mom.id}`);
  assert.deepEqual(momDetail.body.data.dependents, [{ id: kid.id, name: "Hija" }]);

  // Reglas del responsable: no uno mismo, no uno con responsable, no si ya es responsable de otros.
  assert.equal((await t.owner.patch(`/api/panel/clients/${kid.id}`, { guardianId: kid.id })).status, 400);
  const grandkid = await createClientVia(t.owner, { name: "Nieta" });
  assert.equal((await t.owner.patch(`/api/panel/clients/${grandkid.id}`, { guardianId: kid.id })).status, 400);
  assert.equal((await t.owner.patch(`/api/panel/clients/${mom.id}`, { guardianId: grandkid.id })).status, 400);
  const foreignGuardian = await createClientVia(other.owner, { name: "Ajena" });
  assert.equal((await t.owner.patch(`/api/panel/clients/${grandkid.id}`, { guardianId: foreignGuardian.id })).status, 400);

  // Vaciar con null o "".
  const cleared = await t.owner.patch(`/api/panel/clients/${kid.id}`, { guardianId: null, preferredStaffId: "", notes: "" });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.data.guardian, null);
  assert.equal(cleared.body.data.preferredStaffId, null);
  assert.equal(cleared.body.data.notes, null);

  // PATCH vacío → 400.
  assert.equal((await t.owner.patch(`/api/panel/clients/${kid.id}`, {})).status, 400);

  const options = await t.frontDesk.get("/api/panel/clients/form-options");
  assert.deepEqual(
    options.body.data.locations.map((l: { id: string }) => l.id),
    t.locationIds,
  );
  assert.deepEqual(options.body.data.staff, [
    { id: t.staffIds[0], name: "Ana Rojas", active: true },
    { id: t.staffIds[1], name: "Beto Mora", active: false },
  ]);
});

// ─── Derecho de supresión ───────────────────────────────────────────────────

test("anonimizar: confirmación con el teléfono, no quedan datos personales, el historial sigue y queda en audit_log", async () => {
  const t = await createTeam();
  const guardianOf = await createClientVia(t.owner, { name: "Hijo de Gabriela" });
  const c = await createClientVia(t.owner, {
    name: "Gabriela Mora",
    phone: "8888-5555",
    email: "gabriela@example.com",
    birthDate: "1985-01-02",
    notes: "Alergia al látex.",
    tags: ["VIP"],
    preferredLocationId: t.locationIds[0],
    preferredStaffId: t.staffIds[0],
    preferredChannel: "email",
    source: "Referido",
  });
  await t.owner.patch(`/api/panel/clients/${guardianOf.id}`, { guardianId: c.id });
  await refreshClientStats(db, t.businessId, c.id, { visitCount: 2, totalSpentCents: 5_000_000 });
  // Una cita que la referencia: tiene que seguir entera después.
  const [appt] = await withTenant(db, t.businessId, (tx) =>
    tx
      .insert(appointments)
      .values({
        businessId: t.businessId,
        locationId: t.locationIds[0],
        clientId: c.id,
        staffId: t.staffIds[0],
        startsAt: new Date("2026-10-01T15:00:00Z"),
        endsAt: new Date("2026-10-01T16:00:00Z"),
        status: "completed",
      })
      .returning({ id: appointments.id }),
  );

  // Confirmación equivocada → 400; sin confirmación → 400.
  const wrong = await t.owner.post(`/api/panel/clients/${c.id}/anonymize`, { confirmation: "8888-5556" });
  assert.equal(wrong.status, 400);
  assert.ok(wrong.body.fields["body.confirmation"]);
  assert.equal((await t.owner.post(`/api/panel/clients/${c.id}/anonymize`, {})).status, 400);

  const res = await t.owner.post(`/api/panel/clients/${c.id}/anonymize`, { confirmation: "+506 8888 5555" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.equal(d.anonymized, true);
  assert.equal(d.name, "Cliente eliminado");
  for (const key of ["phone", "email", "birthDate", "guardianId", "notes", "source", "preferredLocationId", "preferredStaffId", "preferredChannel", "marketingConsentAt", "marketingOptOutAt"]) {
    assert.equal(d[key], null, key);
  }
  assert.deepEqual(d.tags, []);
  assert.deepEqual(d.dependents, [], "el vínculo con su menor a cargo se corta");
  assert.equal(d.visitCount, 2, "la caché de visitas y gasto queda (sin datos personales)");
  assert.equal(d.totalSpentCents, 5_000_000);

  // En la base no queda NADA de lo personal (fila completa).
  const [row] = await withTenant(db, t.businessId, (tx) => tx.select().from(clients).where(eq(clients.id, c.id)));
  assert.equal(row.name, "Cliente eliminado");
  for (const key of ["phone", "email", "birthDate", "guardianId", "notes", "source", "preferredLocationId", "preferredStaffId", "preferredChannel", "marketingConsentAt", "marketingOptOutAt", "marketingConsentRequestedAt"] as const) {
    assert.equal(row[key], null, `columna ${key}`);
  }
  assert.deepEqual(row.tags, []);
  assert.equal(row.vip, false);
  assert.deepEqual(row.customData, {}, "los campos personalizados se borran");
  assert.ok(row.anonymizedAt instanceof Date, "la marca vive en anonymized_at");
  assert.equal(d.anonymizedAt, row.anonymizedAt.toISOString());
  const { id: _id, businessId: _biz, createdAt: _c, updatedAt: _u, anonymizedAt: _a, ...rest } = row;
  const rowText = JSON.stringify(rest);
  for (const pii of ["Gabriela", "+50688885555", "gabriela@example.com", "1985-01-02", "látex", "VIP", "Referido"]) {
    assert.equal(rowText.includes(pii), false, `queda "${pii}" en la fila: ${rowText}`);
  }
  const [kid] = await withTenant(db, t.businessId, (tx) => tx.select().from(clients).where(eq(clients.id, guardianOf.id)));
  assert.equal(kid.guardianId, null);

  // El historial sigue apuntando al cliente.
  const [stillThere] = await withTenant(db, t.businessId, (tx) =>
    tx.select().from(appointments).where(and(eq(appointments.id, appt.id), eq(appointments.clientId, c.id))),
  );
  assert.ok(stillThere, "la cita sigue entera");

  // Rastro de auditoría sin datos personales.
  const audit = (await listTenantAudit(db, t.businessId)).find((e) => e.action === "client_anonymized");
  assert.ok(audit, "queda en audit_log");
  assert.match(audit.actor, /^user:/);
  assert.equal(audit.details.clientId, c.id);
  assert.equal(audit.details.unlinkedDependents, 1);
  const auditText = JSON.stringify(audit);
  for (const pii of ["Gabriela", "+50688885555", "gabriela@example.com"]) assert.equal(auditText.includes(pii), false, `audit con "${pii}"`);

  // Ya no aparece en la lista ni en la búsqueda; la ficha sí abre (desde una cita vieja).
  const list = await t.owner.get("/api/panel/clients?limit=100");
  assert.equal(list.body.data.items.some((x: { id: string }) => x.id === c.id), false);
  assert.equal((await t.owner.get(`/api/panel/clients?q=${encodeURIComponent("Cliente eliminado")}`)).body.data.items.length, 0);
  assert.equal((await t.owner.get(`/api/panel/clients/${c.id}`)).status, 200);

  // No se edita más ni se anonimiza dos veces; su teléfono queda libre para un cliente nuevo.
  const edit = await t.owner.patch(`/api/panel/clients/${c.id}`, { name: "Gabriela" });
  assert.equal(edit.status, 409);
  assert.equal(edit.body.code, "client_anonymized");
  assert.equal((await t.owner.post(`/api/panel/clients/${c.id}/anonymize`, { confirmation: "x" })).body.code, "client_anonymized");
  assert.equal((await t.owner.post("/api/panel/clients", { name: "Número reciclado", phone: "8888-5555" })).status, 201);
});

test("anonimizar sin teléfono: se confirma con el nombre", async () => {
  const t = await createTeam();
  const c = await createClientVia(t.owner, { name: "Camila Ulate" });
  assert.equal((await t.owner.post(`/api/panel/clients/${c.id}/anonymize`, { confirmation: "Camila" })).status, 400);
  const res = await t.owner.post(`/api/panel/clients/${c.id}/anonymize`, { confirmation: "  camila ulate " });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.anonymized, true);
});

// ─── Aislamiento entre negocios ─────────────────────────────────────────────

test("RLS: un negocio no ve, no edita ni anonimiza clientes de otro", async () => {
  const a = await createTeam();
  const b = await createTeam();
  const secret = await createClientVia(a.owner, { name: "Cliente de A", phone: "8888-6666" });

  const list = await b.owner.get("/api/panel/clients?limit=100");
  assert.equal(list.status, 200);
  assert.equal(list.body.data.items.length, 0, "B no ve a nadie de A");
  assert.equal((await b.owner.get(`/api/panel/clients?q=8888`)).body.data.items.length, 0);

  for (const res of [
    await b.owner.get(`/api/panel/clients/${secret.id}`),
    await b.owner.patch(`/api/panel/clients/${secret.id}`, { name: "Robado" }),
    await b.owner.post(`/api/panel/clients/${secret.id}/anonymize`, { confirmation: "8888-6666" }),
  ]) {
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(res.body.code, "not_found");
  }
  // El responsable tampoco puede ser de otro negocio.
  const mine = await createClientVia(b.owner, { name: "Cliente de B" });
  assert.equal((await b.owner.patch(`/api/panel/clients/${mine.id}`, { guardianId: secret.id })).status, 400);

  // Y el de A sigue intacto.
  const intact = await a.owner.get(`/api/panel/clients/${secret.id}`);
  assert.equal(intact.body.data.name, "Cliente de A");
  assert.equal(intact.body.data.anonymized, false);

  // Id con forma inválida → 400 de validación (no llega a la base).
  assert.equal((await a.owner.get("/api/panel/clients/no-es-uuid")).status, 400);
});
