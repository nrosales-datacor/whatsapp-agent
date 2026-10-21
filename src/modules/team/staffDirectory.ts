import { and, asc, eq } from "drizzle-orm";
import { withTenant, type Executor } from "../../platform/db/scope";
import { memberships, staff } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Directorio mínimo de profesionales para otros módulos (API pública de team): id, nombre
// y si está activo. Lo usa clients para validar y ofrecer el "profesional preferido" sin
// leer la tabla `staff` (test/architecture/moduleBoundaries.test.ts). La gestión completa
// de profesionales (alta, horarios, servicios) es de Configuración › Equipo.
// ─────────────────────────────────────────────────────────────────────────────

export interface StaffOption {
  id: string;
  name: string;
  active: boolean;
}

/** Profesionales del negocio (activos e inactivos), en el orden del negocio. */
export function listStaffOptions(db: Executor, businessId: string): Promise<StaffOption[]> {
  return withTenant(db, businessId, (tx) =>
    tx
      .select({ id: staff.id, name: staff.name, active: staff.active })
      .from(staff)
      .where(eq(staff.businessId, businessId))
      .orderBy(asc(staff.position), asc(staff.name)),
  );
}

/**
 * Profesional vinculado a la membresía de este usuario en el negocio (`staff.membership_id`),
 * o null si no tiene. La agenda lo usa para que el rol `staff` vea y opere solo sus citas
 * ("Mi agenda"). Incluye profesionales desactivados: siguen siendo dueños de su historial.
 */
export async function getStaffIdForUser(db: Executor, businessId: string, userId: string): Promise<string | null> {
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .select({ id: staff.id })
      .from(staff)
      .innerJoin(memberships, eq(memberships.id, staff.membershipId))
      .where(and(eq(staff.businessId, businessId), eq(memberships.businessId, businessId), eq(memberships.userId, userId)))
      .limit(1),
  );
  return row?.id ?? null;
}
