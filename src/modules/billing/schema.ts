import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { instant } from "../../platform/db/columns";
import { systemOnlyPolicy } from "../../platform/db/rls";
import { businesses } from "../business/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Módulo billing: eventos de Stripe ya procesados (I6.6). Stripe reintenta un webhook hasta
// recibir un 2xx y puede mandar el mismo evento más de una vez: el id del evento es la
// clave de idempotencia. La fila se inserta en la MISMA transacción que aplica el cambio
// al negocio, así un evento queda aplicado y registrado, o ninguna de las dos cosas.
//
// Solo de sistema: el webhook llega sin sesión ni negocio (lo resuelve del evento). No se
// guarda el payload (trae datos personales del cliente de Stripe): solo id, tipo y negocio.
// ─────────────────────────────────────────────────────────────────────────────

export const stripeEvents = pgTable(
  "stripe_events",
  {
    // `evt_…` de Stripe.
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    // Negocio al que se aplicó (null si el evento no era de ningún negocio conocido).
    businessId: uuid("business_id").references(() => businesses.id, { onDelete: "set null" }),
    receivedAt: instant("received_at").notNull().defaultNow(),
  },
  (t) => [
    // Purga por antigüedad.
    index("stripe_events_received_idx").on(t.receivedAt),
    systemOnlyPolicy(),
  ],
).enableRLS();

export type StripeEvent = typeof stripeEvents.$inferSelect;
export type NewStripeEvent = typeof stripeEvents.$inferInsert;
