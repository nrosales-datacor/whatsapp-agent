ALTER TABLE "wa_conversaciones" ADD COLUMN "estado" text DEFAULT 'abierta' NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_usuarios" ADD COLUMN "rol" text DEFAULT 'operador' NOT NULL;--> statement-breakpoint
-- Backfill (C2.3): hoy cada negocio tiene exactamente UN usuario (invariante previa a este
-- ítem: el onboarding solo creaba un login por alta). Ese usuario único es, de hecho, el
-- dueño del negocio, así que se promueve a todos los existentes en vez de dejarlos con el
-- default "operador" (que los dejaría sin nadie que pueda editar "Mi negocio" ni gestionar
-- usuarios nuevos).
UPDATE "wa_usuarios" SET "rol" = 'dueno';