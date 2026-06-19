import crypto from "node:crypto";
import type { Cita, Tenant } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Integración con Google Calendar vía SERVICE ACCOUNT (sin dependencias nuevas:
// el JWT se firma con node:crypto y las llamadas van con fetch, igual que el
// resto del proyecto).
//
// CÓMO CONFIGURARLO (una sola vez):
//   1. En Google Cloud Console: creá un proyecto → habilitá "Google Calendar API".
//   2. Creá una SERVICE ACCOUNT y descargá su llave JSON. De ahí salen:
//      GOOGLE_SERVICE_ACCOUNT_EMAIL (client_email) y GOOGLE_PRIVATE_KEY (private_key).
//   3. En el Google Calendar del negocio (calendar.google.com) → Configuración del
//      calendario → "Compartir con determinadas personas" → agregá el email de la
//      service account con permiso "Hacer cambios en eventos".
//   4. GOOGLE_CALENDAR_ID: el "ID del calendario" (en la misma pantalla de
//      configuración; para el calendario principal es el propio gmail).
//
// Si las variables no están en .env, la integración queda APAGADA y el agente
// sigue funcionando normal (solo guarda en la base de datos).
// ─────────────────────────────────────────────────────────────────────────────

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** ¿Está configurada la integración? (las 3 variables presentes) */
export function calendarioConfigurado(): boolean {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
      process.env.GOOGLE_PRIVATE_KEY &&
      process.env.GOOGLE_CALENDAR_ID,
  );
}

// Cache del access token (dura ~1h; lo renovamos 60s antes de que venza).
let tokenCache: { token: string; expiraEn: number } | null = null;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Intercambia un JWT firmado por un access token de Google (OAuth2 server-to-server). */
async function obtenerAccessToken(): Promise<string> {
  const ahora = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expiraEn > ahora + 60) return tokenCache.token;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!;
  // En .env la llave suele venir con "\n" escapados; los restauramos.
  const privateKey = process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, "\n");

  const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({ iss: email, scope: SCOPE, aud: TOKEN_URL, iat: ahora, exp: ahora + 3600 }),
    ),
  );
  const firma = crypto.createSign("RSA-SHA256").update(`${header}.${claims}`).sign(privateKey);
  const jwt = `${header}.${claims}.${b64url(firma)}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Google OAuth (${res.status}): ${await res.text()}`);

  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: data.access_token, expiraEn: ahora + data.expires_in };
  return data.access_token;
}

/** Suma `min` minutos a una hora "HH:mm" y devuelve "HH:mm" (sin pasar de 23:59). */
function sumarMinutos(hhmm: string, min: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = Math.min(h * 60 + m + min, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Crea el evento de la cita en el Google Calendar del negocio.
 * Devuelve el id del evento, o null si la integración no está configurada.
 * El evento guarda NOMBRE y TELÉFONO del cliente, servicio y placa, y trae
 * alertas para el negocio (1 día antes y 2 horas antes).
 */
export async function crearEventoCita(tenant: Tenant, cita: Cita): Promise<string | null> {
  if (!calendarioConfigurado()) return null;

  const servicio = tenant.servicios.find((s) => s.id === cita.servicioId);
  const duracion = servicio?.duracionMin ?? tenant.intervaloAgendaMin;
  const horaFin = sumarMinutos(cita.hora, duracion);

  const evento = {
    summary: `${servicio?.nombre ?? cita.servicioId} — ${cita.clienteNombre}`,
    description: [
      `Cliente: ${cita.clienteNombre}`,
      `Teléfono (WhatsApp): +${cita.clienteWa}`,
      `Servicio: ${servicio?.nombre ?? cita.servicioId}`,
      cita.placa ? `Placa: ${cita.placa}` : null,
      ``,
      `Cita #${cita.id} · agendada por el agente de WhatsApp de ${tenant.nombre}.`,
    ]
      .filter((l) => l !== null)
      .join("\n"),
    start: { dateTime: `${cita.fecha}T${cita.hora}:00`, timeZone: tenant.timezone },
    end: { dateTime: `${cita.fecha}T${horaFin}:00`, timeZone: tenant.timezone },
    // Alertas para el NEGOCIO en su calendario (el cliente recibe las suyas por WhatsApp).
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 24 * 60 }, // 1 día antes
        { method: "popup", minutes: 120 }, // 2 horas antes
      ],
    },
  };

  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID!);
  const token = await obtenerAccessToken();
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(evento),
  });
  if (!res.ok) throw new Error(`Google Calendar (${res.status}): ${await res.text()}`);

  const creado = (await res.json()) as { id: string };
  return creado.id;
}

/** Borra un evento del calendario (ej: al cancelar una cita). No falla si ya no existe. */
export async function eliminarEventoCita(eventId: string): Promise<void> {
  if (!calendarioConfigurado() || !eventId) return;
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID!);
  const token = await obtenerAccessToken();
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  // 404 = no existe · 410 = ya borrado. Ambos son "OK" para nuestros fines.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`Google Calendar borrar (${res.status}): ${await res.text()}`);
  }
}
