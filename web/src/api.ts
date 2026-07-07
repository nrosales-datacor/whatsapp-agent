// ─────────────────────────────────────────────────────────────────────────────
// Capa de API tipada del panel (paso A3 del ROADMAP).
//
// Envuelve los endpoints /api/panel/* del backend. REUSA los tipos del dominio
// desde src/types.ts (import SOLO de tipos → se borra en el build, no acopla el
// runtime del frontend con el del server). En dev, Vite proxya /api al backend
// (ver vite.config.ts); en prod es el mismo origen, así que la cookie de sesión
// viaja sola — igual mandamos credentials: "include" por claridad.
// ─────────────────────────────────────────────────────────────────────────────
import type {
  Cita,
  Conversacion,
  FichaCliente,
  HorarioDia,
  KnowledgeBase,
  Metricas,
  ModoConversacion,
  ResumenConversacion,
  Service,
} from "../../src/types";

export type {
  Cita,
  Conversacion,
  FichaCliente,
  HorarioDia,
  KnowledgeBase,
  Metricas,
  ModoConversacion,
  ResumenConversacion,
  Service,
};

const BASE = "/api/panel";

/** Error de una llamada a la API. `status` 0 = no hubo respuesta (red caída).
 *  `path` (p. ej. "/me" o "/admin/me") permite distinguir la compuerta operador vs admin. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public path?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** true si el error es "no autenticado" (401) → el caller debe mandar al login. */
export function esNoAutenticado(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 401;
}

// Sobre del backend: éxito trae { ok:true, ...datos }; error trae { ok:false, error }.
type Respuesta<T> = ({ ok: true } & T) | { ok: false; error: string };

async function pedir<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: "include",
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      ...init,
    });
  } catch {
    throw new ApiError(0, "No hay conexión con el servidor.", path);
  }

  let cuerpo: Respuesta<T> | null = null;
  try {
    cuerpo = (await res.json()) as Respuesta<T>;
  } catch {
    // respuesta sin JSON (p. ej. 500 en texto plano)
  }

  if (!res.ok || !cuerpo || cuerpo.ok === false) {
    const msg = cuerpo && cuerpo.ok === false ? cuerpo.error : `Error ${res.status || "de red"}`;
    throw new ApiError(res.status, msg, path);
  }
  return cuerpo as T;
}

// ── Tipos de respuesta que enriquecen los del dominio ──
export interface Sesion {
  nombre: string;
  tenantId: string;
  /** Clave pública VAPID para suscribir push (null si el server no tiene push). */
  vapidPublica: string | null;
  /** Catálogo de servicios agendables del negocio (para la Agenda, C2.1). */
  servicios: Service[];
}

/** La ficha que devuelve el panel agrega el nombre del servicio a cada ítem del historial. */
export interface FichaEnriquecida extends Omit<FichaCliente, "historial"> {
  historial: (FichaCliente["historial"][number] & { servicioNombre: string })[];
}

// ── Auth ──
export function login(usuario: string, password: string) {
  return pedir<{ nombre: string; vapidPublica: string | null }>("/login", {
    method: "POST",
    body: JSON.stringify({ usuario, password }),
  });
}

export async function logout(): Promise<void> {
  await pedir("/logout", { method: "POST" });
}

export function me(): Promise<Sesion> {
  return pedir<Sesion>("/me");
}

// ── Bandeja ──
export function listarConversaciones(): Promise<ResumenConversacion[]> {
  return pedir<{ conversaciones: ResumenConversacion[] }>("/conversaciones").then((r) => r.conversaciones);
}

export function obtenerConversacion(id: string): Promise<Conversacion> {
  return pedir<{ conversacion: Conversacion }>(`/conversaciones/${encodeURIComponent(id)}`).then(
    (r) => r.conversacion,
  );
}

export async function responder(id: string, texto: string): Promise<void> {
  await pedir(`/conversaciones/${encodeURIComponent(id)}/responder`, {
    method: "POST",
    body: JSON.stringify({ texto }),
  });
}

export async function cambiarModo(id: string, modo: ModoConversacion): Promise<void> {
  await pedir(`/conversaciones/${encodeURIComponent(id)}/modo`, {
    method: "POST",
    body: JSON.stringify({ modo }),
  });
}

export function obtenerFicha(id: string): Promise<FichaEnriquecida | null> {
  return pedir<{ ficha: FichaEnriquecida | null }>(`/conversaciones/${encodeURIComponent(id)}/ficha`).then(
    (r) => r.ficha,
  );
}

export async function guardarNotas(id: string, notas: string): Promise<void> {
  await pedir(`/conversaciones/${encodeURIComponent(id)}/notas`, {
    method: "POST",
    body: JSON.stringify({ notas }),
  });
}

// ── Métricas ──
export function obtenerMetricas(): Promise<Metricas> {
  return pedir<{ metricas: Metricas }>("/metricas").then((r) => r.metricas);
}

// ── Agenda (C2.1) ──
/** Cita con el nombre del servicio ya resuelto (lo agrega el backend). */
export interface CitaAgenda extends Cita {
  servicioNombre: string;
}

export interface Disponibilidad {
  libres: string[];
  ocupadas: { hora: string; citaId: string; clienteNombre: string }[];
}

export interface DatosCitaManual {
  clienteNombre: string;
  clienteWa: string;
  servicioId: string;
  fecha: string;
  hora: string;
  placa?: string;
  precio?: number;
}

export function listarCitasRango(desde: string, hasta: string): Promise<CitaAgenda[]> {
  const q = new URLSearchParams({ desde, hasta });
  return pedir<{ citas: CitaAgenda[] }>(`/citas?${q}`).then((r) => r.citas);
}

export function disponibilidadCita(fecha: string, servicioId: string): Promise<Disponibilidad> {
  const q = new URLSearchParams({ fecha, servicioId });
  return pedir<Disponibilidad>(`/citas/disponibilidad?${q}`);
}

export function crearCitaManual(datos: DatosCitaManual): Promise<Cita> {
  return pedir<{ cita: Cita }>("/citas", { method: "POST", body: JSON.stringify(datos) }).then((r) => r.cita);
}

export async function confirmarCitaPanel(id: string): Promise<void> {
  await pedir(`/citas/${encodeURIComponent(id)}/confirmar`, { method: "POST" });
}

export async function completarCitaPanel(id: string): Promise<void> {
  await pedir(`/citas/${encodeURIComponent(id)}/completar`, { method: "POST" });
}

export async function cancelarCitaPanel(id: string): Promise<void> {
  await pedir(`/citas/${encodeURIComponent(id)}/cancelar`, { method: "POST" });
}

export async function reprogramarCitaPanel(id: string, fecha: string, hora: string): Promise<void> {
  await pedir(`/citas/${encodeURIComponent(id)}/reprogramar`, {
    method: "POST",
    body: JSON.stringify({ fecha, hora }),
  });
}

// ── Notificaciones push (Web Push) ──
export async function suscribirPush(sub: PushSubscriptionJSON): Promise<void> {
  // El backend lee endpoint + keys.p256dh + keys.auth, justo lo que da sub.toJSON().
  await pedir("/push/suscribir", { method: "POST", body: JSON.stringify(sub) });
}

export async function desuscribirPush(endpoint: string): Promise<void> {
  await pedir("/push/desuscribir", { method: "POST", body: JSON.stringify({ endpoint }) });
}

export function probarPush(): Promise<{ enviadas: number; fallidas: number }> {
  return pedir<{ enviadas: number; fallidas: number }>("/push/probar", { method: "POST" });
}

// ── Admin / onboarding (ROADMAP B3) ──
// Área del superadmin: alta de negocios. Sesión y cookie aparte de la del operador.
export interface AdminSesion {
  admin: true;
  usuario: string;
  /** false en dev sin DATABASE_URL: el alta requiere base. La UI deshabilita el submit. */
  hayDb: boolean;
}

export interface TenantResumen {
  id: string;
  nombre: string;
  phoneNumberId: string;
  moneda: string;
  timezone: string;
  servicios: number;
}

/** Cuerpo del alta de negocio (lo valida y normaliza el backend igual). */
export interface AltaTenant {
  tenant: {
    id: string;
    nombre: string;
    phoneNumberId: string;
    accessToken?: string;
    timezone: string;
    moneda: string;
    ubicacion: string;
    intervaloAgendaMin: number;
    horario: Record<number, HorarioDia>;
    servicios: Service[];
    kb: KnowledgeBase;
  };
  usuario: string;
  password: string;
}

export function adminLogin(usuario: string, password: string) {
  return pedir("/admin/login", { method: "POST", body: JSON.stringify({ usuario, password }) });
}

export async function adminLogout(): Promise<void> {
  await pedir("/admin/logout", { method: "POST" });
}

export function adminMe(): Promise<AdminSesion> {
  return pedir<AdminSesion>("/admin/me");
}

export function adminListarTenants(): Promise<TenantResumen[]> {
  return pedir<{ tenants: TenantResumen[] }>("/admin/tenants").then((r) => r.tenants);
}

export function adminCrearTenant(body: AltaTenant): Promise<{ tenantId: string }> {
  return pedir<{ tenantId: string }>("/admin/tenants", { method: "POST", body: JSON.stringify(body) });
}
