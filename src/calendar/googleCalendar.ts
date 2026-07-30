import crypto from "node:crypto";
import type { Cita, Tenant } from "../types";
import { conTimeout, TIMEOUT_GOOGLE_MS } from "../red/timeouts";

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
//   4. El "ID del calendario" (en la misma pantalla de configuración; para el
//      calendario principal es el propio gmail) se guarda POR NEGOCIO en
//      `wa_tenants.google_calendar_id`, editable desde el panel → "Mi negocio".
//
// La service account (email + llave privada) sí es global: es NUESTRA credencial,
// y cada negocio la autoriza sobre SU calendario compartiéndoselo. El calendario,
// en cambio, es por tenant — ver la nota de abajo.
//
// Si falta la service account o el negocio no configuró su calendario, la
// integración queda APAGADA para ese negocio y el agente sigue funcionando normal
// (la fuente de verdad de las citas es nuestra base, no Calendar).
//
// ⚠️ AUDITORÍA BLOQ-05 (2026-07-27): el calendario ERA una env global
// (`GOOGLE_CALENDAR_ID`) compartida por todos los tenants. Con dos clientes, las
// citas de uno (con nombre, teléfono, servicio y precio del cliente final) se
// escribían en el Google Calendar del otro, y una cancelación podía borrar eventos
// ajenos: fuga de datos personales entre negocios, en un sistema de terceros. Ahora
// el calendario sale SIEMPRE del tenant. El fallback a la env sigue existiendo,
// pero solo para el tenant nombrado explícitamente en `GOOGLE_CALENDAR_TENANT_ID`
// (compatibilidad con el piloto, que ya tenía su calendario en el .env): cualquier
// otro tenant sin su propia columna queda apagado, nunca redirigido.
// ─────────────────────────────────────────────────────────────────────────────

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * ¿Están las credenciales globales de la service account? No alcanza por sí solo:
 * cada negocio además tiene que tener SU calendario (ver `calendarioDeTenant`).
 * Se exporta solo para el log de arranque del server.
 */
export function credencialesCalendarioConfiguradas(): boolean {
  return credencialesConfiguradas();
}

function credencialesConfiguradas(): boolean {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY);
}

/**
 * Calendario de ESTE negocio, o null si no tiene. Nunca devuelve el calendario de
 * otro tenant: la env `GOOGLE_CALENDAR_ID` solo aplica al tenant nombrado en
 * `GOOGLE_CALENDAR_TENANT_ID` (legado del piloto de un solo cliente).
 */
export function calendarioDeTenant(tenant: Tenant): string | null {
  if (tenant.googleCalendarId) return tenant.googleCalendarId;
  const legadoTenantId = process.env.GOOGLE_CALENDAR_TENANT_ID;
  if (legadoTenantId && legadoTenantId === tenant.id && process.env.GOOGLE_CALENDAR_ID) {
    return process.env.GOOGLE_CALENDAR_ID;
  }
  return null;
}

/** ¿Está configurada la integración PARA ESTE NEGOCIO? */
export function calendarioConfigurado(tenant: Tenant): boolean {
  return credencialesConfiguradas() && calendarioDeTenant(tenant) !== null;
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
    signal: conTimeout(TIMEOUT_GOOGLE_MS),
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
  const calendario = calendarioDeTenant(tenant);
  if (!credencialesConfiguradas() || !calendario) return null;

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

  const calendarId = encodeURIComponent(calendario);
  const token = await obtenerAccessToken();
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(evento),
    signal: conTimeout(TIMEOUT_GOOGLE_MS),
  });
  if (!res.ok) throw new Error(`Google Calendar (${res.status}): ${await res.text()}`);

  const creado = (await res.json()) as { id: string };
  return creado.id;
}

/**
 * Actualiza fecha/hora (y datos) de un evento existente al reprogramar la cita.
 * PATCH sobre el evento; no falla si la integración está apagada o falta eventId.
 */
export async function actualizarEventoCita(tenant: Tenant, cita: Cita): Promise<void> {
  const calendario = calendarioDeTenant(tenant);
  if (!credencialesConfiguradas() || !calendario || !cita.gcalEventId) return;

  const servicio = tenant.servicios.find((s) => s.id === cita.servicioId);
  const duracion = servicio?.duracionMin ?? tenant.intervaloAgendaMin;
  const horaFin = sumarMinutos(cita.hora, duracion);

  const cambios = {
    summary: `${servicio?.nombre ?? cita.servicioId} — ${cita.clienteNombre}`,
    start: { dateTime: `${cita.fecha}T${cita.hora}:00`, timeZone: tenant.timezone },
    end: { dateTime: `${cita.fecha}T${horaFin}:00`, timeZone: tenant.timezone },
  };

  const calendarId = encodeURIComponent(calendario);
  const token = await obtenerAccessToken();
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(cita.gcalEventId)}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cambios),
      signal: conTimeout(TIMEOUT_GOOGLE_MS),
    },
  );
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`Google Calendar actualizar (${res.status}): ${await res.text()}`);
  }
}

/**
 * Borra un evento del calendario (ej: al cancelar una cita). No falla si ya no existe.
 * Recibe el `tenant` (no solo el eventId) porque el DELETE va contra el calendario de
 * ESE negocio: con un calendario global, un tenant podía borrar eventos de otro.
 */
export async function eliminarEventoCita(tenant: Tenant, eventId: string): Promise<void> {
  const calendario = calendarioDeTenant(tenant);
  if (!credencialesConfiguradas() || !calendario || !eventId) return;
  const calendarId = encodeURIComponent(calendario);
  const token = await obtenerAccessToken();
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` }, signal: conTimeout(TIMEOUT_GOOGLE_MS) },
  );
  // 404 = no existe · 410 = ya borrado. Ambos son "OK" para nuestros fines.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`Google Calendar borrar (${res.status}): ${await res.text()}`);
  }
}
