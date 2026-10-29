import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { systemOnlyPolicy, tenantPolicy } from "./rls";

// ─────────────────────────────────────────────────────────────────────────────
// Tablas de la PLATAFORMA (las de cada módulo viven en src/modules/<módulo>/schema.ts).
// Convenciones (PLAN-GESTION.md §4): nombres en inglés, tablas en plural y snake_case,
// `id` uuid, `business_id` + política RLS en toda tabla de negocio, instantes
// `timestamptz`. Toda tabla nueva: `.enableRLS()` + `tenantPolicy()` o `systemOnlyPolicy()`
// (lo exige test/security/rls.test.ts) y registrarla en ./schemaRegistry.ts.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Lease de liderazgo de los schedulers (src/platform/net/leaderLease.ts). Los loops
// periódicos recorren TODOS los negocios en cada tick y no tienen un claim atómico por
// unidad de trabajo: con N réplicas `ROLE=worker`, sin esta tabla correrían todos a la
// vez. Una fila por scheduler (`name`); el titular vigente se decide con una única
// sentencia atómica (`INSERT … ON CONFLICT … WHERE`), sin advisory locks de sesión (no
// confiables contra el pooler de Supabase en modo transacción).
// ─────────────────────────────────────────────────────────────────────────────
export const leaderLeases = pgTable(
  "leader_leases",
  {
    // Clave del scheduler, p. ej. "metrics" o "reminders".
    name: text("name").primaryKey(),
    // Id al azar del proceso que tiene el lease ahora mismo (uno por proceso). No es un
    // usuario ni un negocio.
    holder: text("holder").notNull(),
    // Hasta cuándo vale el lease. Vencido → cualquier otro titular puede tomarlo en su
    // próximo intento; no hace falta heartbeat ni quorum aparte.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  () => [systemOnlyPolicy()],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Registro auditable de operaciones sensibles (src/platform/audit/auditLog.ts): pausar o
// dar de baja un negocio, reconectar una integración, borrar los datos de un cliente
// final (derecho de supresión, Ley 8968), logins del superadmin, resets de clave. Es un
// log append-only: no se poda, no se restaura y no se borra con la baja del negocio (es
// el rastro de que la baja ocurrió).
//
// `business_id` null = entrada de PLATAFORMA (p. ej. el login del superadmin): ninguna
// política de negocio la alcanza, solo el contexto de sistema. Sin FK a `businesses` a
// propósito: el rastro sobrevive a la baja del negocio.
//
// `details` NUNCA guarda datos personales ni secretos: para un borrado de cliente se
// guardan conteos e ids internos (no el teléfono, ni el nombre, ni mensajes); para una
// reconexión, el id público nuevo pero jamás el token.
// ─────────────────────────────────────────────────────────────────────────────
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id"),
    // snake_case en inglés: "business_paused", "admin_login", "password_reset"…
    action: text("action").notNull(),
    // Quién lo hizo: "superadmin:<usuario>" o "user:<id>".
    actor: text("actor").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_business_created_idx").on(t.businessId, t.createdAt), tenantPolicy()],
).enableRLS();
