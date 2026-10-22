import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { businesses } from "../../src/modules/business/schema";
import { clients, type NewClient } from "../../src/modules/clients/schema";
import { appointments, type NewAppointment } from "../../src/modules/scheduling/schema";
import { staff } from "../../src/modules/team/schema";
import { withTenant, type Db } from "../../src/platform/db/scope";
import { createTestBusiness, createTestMember } from "./identityFixtures";
import { Browser } from "./panelClient";

// ─────────────────────────────────────────────────────────────────────────────
// Datos para los tests del CRM de clientes (I3) por HTTP: un negocio (Pro o Básico) con
// dos sucursales, dos profesionales (el primero vinculado al usuario con rol `staff`) y una
// sesión por rol; clientes y citas insertados directo (con `withTenant`, el camino de la
// app, así sirve con la base corriendo como `app_runtime`).
// ─────────────────────────────────────────────────────────────────────────────

export interface CrmTeam {
  businessId: string;
  locationIds: string[];
  /** [0] = el del usuario `staff` (Ana), [1] = otro (Beto, sin usuario). */
  staffIds: string[];
  owner: Browser;
  admin: Browser;
  frontDesk: Browser;
  staffMember: Browser;
}

async function loggedIn(baseUrl: string, email: string, password: string | null): Promise<Browser> {
  const b = new Browser(baseUrl);
  const res = await b.post("/api/panel/auth/login", { email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return b;
}

export async function createCrmTeam(db: Db, baseUrl: string, options: { plan?: "basic" | "pro"; country?: string } = {}): Promise<CrmTeam> {
  const biz = await createTestBusiness(db, { plan: options.plan ?? "pro" });
  const members = {
    owner: await createTestMember(db, { businessId: biz.businessId, role: "owner" }),
    admin: await createTestMember(db, { businessId: biz.businessId, role: "admin" }),
    frontDesk: await createTestMember(db, { businessId: biz.businessId, role: "front_desk" }),
    staffMember: await createTestMember(db, { businessId: biz.businessId, role: "staff" }),
  };
  const staffIds = await withTenant(db, biz.businessId, async (tx) => {
    await tx
      .update(businesses)
      .set({ country: options.country ?? "CR" })
      .where(eq(businesses.id, biz.businessId));
    const rows = await tx
      .insert(staff)
      .values([
        { businessId: biz.businessId, name: "Ana Rojas", position: 0, membershipId: members.staffMember.membershipId },
        { businessId: biz.businessId, name: "Beto Mora", position: 1 },
      ])
      .returning({ id: staff.id });
    return rows.map((r) => r.id);
  });
  return {
    businessId: biz.businessId,
    locationIds: biz.locationIds,
    staffIds,
    owner: await loggedIn(baseUrl, members.owner.email, members.owner.password),
    admin: await loggedIn(baseUrl, members.admin.email, members.admin.password),
    frontDesk: await loggedIn(baseUrl, members.frontDesk.email, members.frontDesk.password),
    staffMember: await loggedIn(baseUrl, members.staffMember.email, members.staffMember.password),
  };
}

/** Inserta un cliente con lo que haga falta (caché de visitas, VIP, etiquetas…). */
export async function insertClient(db: Db, businessId: string, values: Partial<NewClient> & { name: string }): Promise<string> {
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .insert(clients)
      .values({ businessId, ...values })
      .returning({ id: clients.id }),
  );
  return row.id;
}

/** Inserta una cita (sin líneas de servicio: alcanza para "Mis clientes"). */
export async function insertAppointment(
  db: Db,
  team: Pick<CrmTeam, "businessId" | "locationIds">,
  input: { clientId: string; staffId: string; startsAt: Date; status?: NewAppointment["status"] },
): Promise<string> {
  const [row] = await withTenant(db, team.businessId, (tx) =>
    tx
      .insert(appointments)
      .values({
        businessId: team.businessId,
        locationId: team.locationIds[0],
        clientId: input.clientId,
        staffId: input.staffId,
        startsAt: input.startsAt,
        endsAt: new Date(input.startsAt.getTime() + 30 * 60_000),
        status: input.status ?? "completed",
      })
      .returning({ id: appointments.id }),
  );
  return row.id;
}
