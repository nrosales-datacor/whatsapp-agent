import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { instant } from "../../platform/db/columns";
import { systemOnlyPolicy } from "../../platform/db/rls";
import { businesses } from "../business/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Módulo billing: lo de Stripe que no es del negocio (lo del negocio vive en
// `businesses`: cliente, suscripción, período, gracia).
//
// Eventos de Stripe ya procesados: la idempotencia del webhook. Stripe reintenta un mismo
// evento (mismo `id`) hasta recibir un 2xx y puede mandarlo más de una vez; el webhook
// inserta el id en la MISMA transacción que aplica el cambio (`ON CONFLICT DO NOTHING`):
// o queda el cambio y el id, o ninguno, y un repetido no hace nada.
//
// Solo de sistema: lo escribe el webhook (sin sesión) y ningún negocio tiene por qué verlo.
// Sin datos personales: id, tipo y el negocio que resolvió.
// ─────────────────────────────────────────────────────────────────────────────
export const stripeEvents = pgTable(
  "stripe_events",
  {
    // Id del evento de Stripe (`evt_…`).
    id: text("id").primaryKey(),
    // Tipo (`customer.subscription.updated`, `invoice.paid`…).
    type: text("type").notNull(),
    // Negocio al que se aplicó (null = no se pudo resolver: se registra igual para no reprocesarlo).
    businessId: uuid("business_id").references(() => businesses.id, { onDelete: "set null" }),
    receivedAt: instant("received_at").notNull().defaultNow(),
  },
  (t) => [index("stripe_events_business_idx").on(t.businessId, t.receivedAt), systemOnlyPolicy()],
).enableRLS();

export type StripeEventRow = typeof stripeEvents.$inferSelect;
export type NewStripeEventRow = typeof stripeEvents.$inferInsert;
