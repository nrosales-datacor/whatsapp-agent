-- I5 · Reportes, Inicio completo y métricas de producto: último día de actividad de cada
-- membresía (cuenta "usuarios activos" en daily_usage una vez por persona y día) e índice
-- de citas por fecha de creación (lo que agendó cada canal en un rango).
ALTER TABLE "memberships" ADD COLUMN "last_active_on" date;--> statement-breakpoint
CREATE INDEX "appointments_business_created_idx" ON "appointments" USING btree ("business_id","created_at");