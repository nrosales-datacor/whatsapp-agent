import { randomUUID } from "node:crypto";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "../db/schema";
import type { Repositorio, Tenant } from "../types";
import { listarTenants } from "../config/tenantStore";
import { tenantPuede } from "../billing/planes";
import { capturarError } from "../observabilidad/sentry";
import { mapConLimite } from "../red/concurrencia";
import { iniciarCicloSinSolape } from "../red/programador";
import { intentarLiderazgo } from "../red/liderazgo";

type DB = PostgresJsDatabase<typeof schema>;

// ─────────────────────────────────────────────────────────────────────────────
// Reputación en Google vía Places API (Carril D, Fase 1 - 1.3-c, motor de reseñas
// completo). Job diario: por cada tenant Pro con `googlePlaceId` configurado, pide
// rating + total de reseñas y guarda un snapshot (para graficar la evolución en el
// dashboard). Gateado por GOOGLE_PLACES_API_KEY — sin ella es NO-OP total, mismo
// patrón que Calendar/Sentry/Push (ver DEPLOY.md).
//
// "1 llamada/día/tenant" (dentro del free tier de Places): el tick corre cada hora
// pero cada tenant se salta si YA tiene un snapshot de HOY (evita gastar cuota si el
// proceso se reinicia varias veces el mismo día).
// ─────────────────────────────────────────────────────────────────────────────

const INTERVALO_MIN = Number(process.env.REPUTACION_INTERVALO_MIN ?? 60);
// Mismo criterio de F12 que reminders/scheduler.ts: concurrencia acotada en vez
// de recorrer los tenants en serie.
const CONCURRENCIA = Number(process.env.REPUTACION_CONCURRENCIA ?? 5);

// Líder del ciclo (ROADMAP F6): mismo criterio que reminders/scheduler.ts —
// con `ROL=worker` y N réplicas, solo el titular vigente del lease hace el
// trabajo real; ver src/red/liderazgo.ts.
const NOMBRE_LIDERAZGO = "reputacion";
const TITULAR_LIDERAZGO = randomUUID();

export function placesConfigurado(): boolean {
  return !!process.env.GOOGLE_PLACES_API_KEY;
}

interface PlaceDetails {
  rating: number;
  totalResenas: number;
}

/** Pide rating + total de reseñas de un negocio a la Places API (Place Details). */
export async function consultarPlaceDetails(placeId: string, apiKey: string): Promise<PlaceDetails> {
  const url =
    `https://maps.googleapis.com/maps/api/place/details/json` +
    `?place_id=${encodeURIComponent(placeId)}&fields=rating,user_ratings_total&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Error consultando Places API (${res.status})`);
  const body = (await res.json()) as { status: string; result?: { rating?: number; user_ratings_total?: number }; error_message?: string };
  if (body.status !== "OK") throw new Error(`Places API respondió "${body.status}"${body.error_message ? `: ${body.error_message}` : ""}`);
  return { rating: body.result?.rating ?? 0, totalResenas: body.result?.user_ratings_total ?? 0 };
}

/** "YYYY-MM-DD" de hoy en la zona del tenant (mismo criterio que reminders/scheduler.ts). */
function hoyEnTz(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(
    new Date(),
  );
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function procesarTenant(tenant: Tenant, repo: Repositorio, apiKey: string): Promise<void> {
  if (!tenant.googlePlaceId || !tenantPuede(tenant, "resenasPro")) return;
  const hoy = hoyEnTz(tenant.timezone);
  const [ultimo] = await repo.historicoReputacion(tenant.id, 1);
  if (ultimo?.fecha === hoy) return; // ya corrió hoy: no gastar cuota de nuevo

  const { rating, totalResenas } = await consultarPlaceDetails(tenant.googlePlaceId, apiKey);
  await repo.guardarSnapshotReputacion(tenant.id, hoy, rating, totalResenas);
  console.log(`[reputacion] ${tenant.id}: rating ${rating} · ${totalResenas} reseñas`);
}

/**
 * Arranca el job. No-op sin GOOGLE_PLACES_API_KEY. Llamar UNA vez al iniciar el
 * servidor.
 *
 * F12: mismo tratamiento que `reminders/scheduler.ts` — ciclo sin solapamiento
 * (`iniciarCicloSinSolape`) y tenants procesados con concurrencia acotada
 * (`mapConLimite`) en vez de en serie.
 *
 * `db` es para el lease de liderazgo (F6, ver `intentarLiderazgo`): con
 * `ROL=worker` y N réplicas, cada tick primero intenta renovarlo y solo si lo
 * tiene gasta cuota de Places; `null` (modo memoria o `ROL=todo`) siempre gana.
 */
export function iniciarReputacion(repo: Repositorio, db: DB | null): void {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return;

  const intervaloMs = INTERVALO_MIN * 60 * 1000;
  iniciarCicloSinSolape({
    etiqueta: "reputacion",
    intervaloMs,
    sugerenciaEscalado: "Con más tenants esto va a seguir empeorando: subir REPUTACION_CONCURRENCIA o REPUTACION_INTERVALO_MIN.",
    tick: async () => {
      if (!(await intentarLiderazgo(db, NOMBRE_LIDERAZGO, TITULAR_LIDERAZGO, intervaloMs * 3))) {
        console.log("[reputacion] en espera: otro proceso tiene el liderazgo este tick.");
        return;
      }
      await mapConLimite(listarTenants(), CONCURRENCIA, async (tenant) => {
        try {
          await procesarTenant(tenant, repo, apiKey);
        } catch (e) {
          console.error(`[reputacion] error procesando tenant ${tenant.id}:`, e);
          capturarError(e, { loop: "reputacion", tenantId: tenant.id });
        }
      });
    },
    onError: (e, momento) => {
      console.error(`[reputacion] ${momento}:`, e);
      capturarError(e, { loop: "reputacion", momento });
    },
  });

  console.log(
    `Reputación (Places API) activa: chequeo cada ${INTERVALO_MIN} min, concurrencia ${CONCURRENCIA}, 1 llamada/día/tenant configurado.`,
  );
}
