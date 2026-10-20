import { sql } from "drizzle-orm";
import { bigint, check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, timestamps, updatedAt, uuidPk } from "./columns";
import { systemOnlyPolicy, tenantPolicy } from "./rls";

// ─────────────────────────────────────────────────────────────────────────────
// Tablas de la PLATAFORMA (las de cada módulo viven en src/modules/<módulo>/schema.ts).
// Convenciones (PLAN-GESTION.md §4): nombres en inglés, tablas en plural y snake_case,
// `id` uuid, `business_id` + política RLS en toda tabla de negocio, instantes
// `timestamptz`. Toda tabla nueva: `.enableRLS()` + `tenantPolicy()` o `systemOnlyPolicy()`
// (lo exige test/security/rls.test.ts) y registrarla en ./schemaRegistry.ts.
//
// FKs hacia tablas de módulos (`businesses`, `users`): la plataforma no importa de
// src/modules (test/architecture/moduleBoundaries.test.ts), así que esas FKs NO se
// declaran acá sino en SQL a mano en drizzle/0002_domain_constraints.sql, y
// test/reliability/domainSchema.test.ts verifica que existan en la base migrada.
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

// ─────────────────────────────────────────────────────────────────────────────
// Suscripciones Web Push del panel (PWA), por negocio Y por usuario. Llevan el
// `session_epoch` del usuario con el que se registraron: si la cuenta se desactiva o su
// epoch sube (cambio de clave, rol o estado), la suscripción deja de recibir y se borra en
// el próximo envío. Así desactivar a alguien corta también las notificaciones de su
// teléfono (que traen fragmentos de mensajes de clientes).
// FKs (en SQL, ver arriba): business_id → businesses y user_id → users, ambas CASCADE.
// ─────────────────────────────────────────────────────────────────────────────
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuidPk(),
    businessId: uuid("business_id").notNull(),
    userId: uuid("user_id").notNull(),
    sessionEpoch: integer("session_epoch").notNull(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint_uq").on(t.endpoint),
    index("push_subscriptions_business_idx").on(t.businessId),
    index("push_subscriptions_user_idx").on(t.userId),
    tenantPolicy(),
  ],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Historial de configuración del negocio: cada cambio de una pantalla de configuración
// guarda, en la MISMA transacción que el cambio, el estado completo como quedó
// (`snapshot`, no un diff) con quién y cuándo. Restaurar una versión crea una fila nueva
// (como un revert), nunca reescribe el historial.
// FKs (en SQL): business_id → businesses CASCADE; changed_by → users SET NULL (el
// historial sobrevive a la baja del usuario).
// ─────────────────────────────────────────────────────────────────────────────
export const configHistory = pgTable(
  "config_history",
  {
    id: uuidPk(),
    businessId: uuid("business_id").notNull(),
    // Qué configuración cambió: "business", "ai_settings", "location"…
    entity: text("entity").notNull(),
    // Id de la fila cambiada cuando la entidad tiene varias (p. ej. una sucursal).
    entityId: uuid("entity_id"),
    snapshot: jsonb("snapshot").notNull(),
    changedBy: uuid("changed_by"),
    createdAt: createdAt(),
  },
  (t) => [index("config_history_business_entity_idx").on(t.businessId, t.entity, t.createdAt), tenantPolicy()],
).enableRLS();

// ─────────────────────────────────────────────────────────────────────────────
// Uso diario por negocio y métrica (PLAN-GESTION.md §2, "Medible"): citas creadas, pagos
// registrados, usuarios activos, conversaciones IA, costo LLM… Mide activación y
// retención en el superadmin. Una fila por (negocio, día, métrica) con incrementos
// atómicos (INSERT … ON CONFLICT DO UPDATE SET value = value + n). La lista de métricas
// crece sin migración: solo se exige snake_case.
// FK (en SQL): business_id → businesses CASCADE.
// ─────────────────────────────────────────────────────────────────────────────
export const dailyUsage = pgTable(
  "daily_usage",
  {
    businessId: uuid("business_id").notNull(),
    date: date("date").notNull(),
    metric: text("metric").notNull(),
    value: bigint("value", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.businessId, t.date, t.metric] }),
    // Superadmin: una métrica en un rango de días, para todos los negocios.
    index("daily_usage_metric_date_idx").on(t.metric, t.date),
    check("daily_usage_metric_check", sql`${t.metric} ~ '^[a-z][a-z0-9_]*$'`),
    tenantPolicy(),
  ],
).enableRLS();

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;
export type ConfigHistoryEntry = typeof configHistory.$inferSelect;
export type NewConfigHistoryEntry = typeof configHistory.$inferInsert;
export type DailyUsage = typeof dailyUsage.$inferSelect;
export type NewDailyUsage = typeof dailyUsage.$inferInsert;
