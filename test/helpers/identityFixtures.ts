import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { businesses, locations } from "../../src/modules/business/schema";
import { membershipLocations, memberships, users } from "../../src/modules/team/schema";
import type { Role } from "../../src/platform/auth/sessionToken";
import { hashPassword } from "../../src/platform/auth/password";
import { withSystem, withTenant, type Db } from "../../src/platform/db/scope";

// ─────────────────────────────────────────────────────────────────────────────
// Datos de identidad para los tests: negocios con sucursales, usuarios con clave y
// membresías con rol y sucursales. Todo por `withSystem`/`withTenant` (el camino de la
// app), así sirve con la base corriendo como `app_runtime` (sin BYPASSRLS).
// ─────────────────────────────────────────────────────────────────────────────

let seq = 0;
/** Email único por test (los emails son únicos en toda la plataforma). */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${++seq}-${randomUUID().slice(0, 8)}@example.test`;
}

export interface TestBusiness {
  businessId: string;
  name: string;
  /** Sucursales en orden: la primera es "Central". */
  locationIds: string[];
}

/** Negocio activo con N sucursales (default 2: "Central" y "Norte"). */
export async function createTestBusiness(db: Db, options: { name?: string; locations?: string[]; status?: "active" | "paused" } = {}): Promise<TestBusiness> {
  const businessId = randomUUID();
  const name = options.name ?? `Negocio ${businessId.slice(0, 6)}`;
  const names = options.locations ?? ["Central", "Norte"];
  return withTenant(db, businessId, async (tx) => {
    await tx.insert(businesses).values({
      id: businessId,
      slug: `negocio-${businessId.slice(0, 8)}`,
      name,
      status: options.status ?? "active",
      branding: { accentColor: "#123456" },
    });
    const rows = await tx
      .insert(locations)
      .values(names.map((n, position) => ({ businessId, name: n, timezone: "America/Costa_Rica", position })))
      .returning({ id: locations.id });
    return { businessId, name, locationIds: rows.map((r) => r.id) };
  });
}

/** Usuario con clave (null = invitado que todavía no la eligió). */
export async function createTestUser(
  db: Db,
  options: { email?: string; name?: string; password?: string | null; active?: boolean; mustChangePassword?: boolean } = {},
): Promise<{ userId: string; email: string; password: string | null }> {
  const email = options.email ?? uniqueEmail("user");
  const password = options.password === undefined ? "clave-de-prueba-1" : options.password;
  const passwordHash = password === null ? null : await hashPassword(password);
  const [row] = await withSystem(db, (tx) =>
    tx
      .insert(users)
      .values({
        email,
        name: options.name ?? "Persona de prueba",
        passwordHash,
        active: options.active ?? true,
        mustChangePassword: options.mustChangePassword ?? false,
      })
      .returning({ id: users.id }),
  );
  return { userId: row.id, email, password };
}

/** Membresía con rol y (opcional) sucursales. */
export async function addTestMembership(
  db: Db,
  input: { businessId: string; userId: string; role: Role; locationIds?: string[]; active?: boolean },
): Promise<string> {
  return withTenant(db, input.businessId, async (tx) => {
    const [m] = await tx
      .insert(memberships)
      .values({ businessId: input.businessId, userId: input.userId, role: input.role, active: input.active ?? true })
      .returning({ id: memberships.id });
    if (input.locationIds?.length) {
      await tx
        .insert(membershipLocations)
        .values(input.locationIds.map((locationId) => ({ businessId: input.businessId, membershipId: m.id, locationId })));
    }
    return m.id;
  });
}

/** Usuario + membresía en un paso. */
export async function createTestMember(
  db: Db,
  input: { businessId: string; role: Role; locationIds?: string[]; email?: string; name?: string; password?: string | null },
): Promise<{ userId: string; membershipId: string; email: string; password: string | null }> {
  const user = await createTestUser(db, { email: input.email, name: input.name, password: input.password });
  const membershipId = await addTestMembership(db, { businessId: input.businessId, userId: user.userId, role: input.role, locationIds: input.locationIds });
  return { ...user, membershipId };
}

/** Epoch vigente de una cuenta (contexto de sistema). */
export async function sessionEpochOf(db: Db, userId: string): Promise<number> {
  const [row] = await withSystem(db, (tx) => tx.select({ e: users.sessionEpoch }).from(users).where(eq(users.id, userId)));
  return row.e;
}
