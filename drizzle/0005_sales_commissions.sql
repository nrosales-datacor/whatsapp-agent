-- I4 · Ventas y comisiones: devoluciones enlazadas a su pago (refund_of_id) y movimientos de
-- comisión con cita, sucursal y fecha (earned_at), un solo movimiento abierto por línea y
-- ajustes (montos negativos) después de liquidar. Las columnas NOT NULL nuevas no llevan
-- default: commission_entries no tenía filas (no había lógica que las escribiera).
ALTER TABLE "commission_entries" DROP CONSTRAINT "commission_entries_amounts_check";--> statement-breakpoint
DROP INDEX "commission_entries_line_uq";--> statement-breakpoint
DROP INDEX "commission_entries_staff_status_idx";--> statement-breakpoint
ALTER TABLE "commission_entries" ADD COLUMN "appointment_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "commission_entries" ADD COLUMN "location_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "commission_entries" ADD COLUMN "earned_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refund_of_id" uuid;--> statement-breakpoint
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_of_id_payments_id_fk" FOREIGN KEY ("refund_of_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commission_entries_open_line_uq" ON "commission_entries" USING btree ("appointment_service_id") WHERE "commission_entries"."payout_id" IS NULL;--> statement-breakpoint
CREATE INDEX "commission_entries_line_idx" ON "commission_entries" USING btree ("appointment_service_id");--> statement-breakpoint
CREATE INDEX "commission_entries_staff_earned_idx" ON "commission_entries" USING btree ("business_id","staff_id","earned_at");--> statement-breakpoint
CREATE INDEX "commission_entries_business_earned_idx" ON "commission_entries" USING btree ("business_id","earned_at");--> statement-breakpoint
CREATE INDEX "payments_refund_of_idx" ON "payments" USING btree ("refund_of_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_of_check" CHECK (("payments"."kind" = 'refund') = ("payments"."refund_of_id" IS NOT NULL));