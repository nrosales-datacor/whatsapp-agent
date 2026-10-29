ALTER TABLE "clients" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "clients_tags_idx" ON "clients" USING gin ("tags");--> statement-breakpoint
-- Backfill (I3): la marca provisoria de "datos eliminados" vivía en custom_data
-- ("$anonymizedAt", ISO 8601) mientras no había columna. Pasa a `anonymized_at` y se quita
-- de custom_data. Un valor que no sea una fecha ISO usa updated_at (la anonimización es lo
-- último que se le hizo a la fila). SQL a mano dentro de la migración generada: no cambia
-- el esquema, así que el snapshot sigue igual y `npm run db:check` no lo ve como drift.
-- test/reliability/clientsAnonymizedMigration.test.ts falla si esto se pierde.
UPDATE "clients"
   SET "anonymized_at" = CASE
         WHEN "custom_data" ->> '$anonymizedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$'
           THEN ("custom_data" ->> '$anonymizedAt')::timestamptz
         ELSE "updated_at"
       END,
       "custom_data" = "custom_data" - '$anonymizedAt'
 WHERE "custom_data" ? '$anonymizedAt';
