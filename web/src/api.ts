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
  Bloqueo,
  Campania,
  CampaniaConDetalle,
  Cita,
  ClienteSegmento,
  Conversacion,
  EstadoConversacion,
  FichaCliente,
  HorarioDia,
  KnowledgeBase,
  Metricas,
  ModoConversacion,
  Rol,
  ResumenConversacion,
  SegmentoFiltro,
  Service,
} from "../../src/types";

export type {
  Bloqueo,
  Campania,
  CampaniaConDetalle,
  Cita,
  ClienteSegmento,
  Conversacion,
  EstadoConversacion,
  FichaCliente,
  HorarioDia,
  KnowledgeBase,
  Metricas,
  ModoConversacion,
  Rol,
  ResumenConversacion,
  SegmentoFiltro,
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

/** White-label por tenant (ROADMAP C4.1). Todo null = paleta verde default del panel. */
export interface Marca {
  colorAcento: string | null;
  colorHeader: string | null;
  logoUrl: string | null;
}

// ── Tipos de respuesta que enriquecen los del dominio ──
export interface Sesion {
  nombre: string;
  tenantId: string;
  /** Id del usuario logueado (para que "Usuarios" pueda identificar la propia fila y evitar auto-lockout). */
  usuarioId: string;
  /** Rol del usuario logueado (C2.3): "dueno" ve "Mi negocio" y "Usuarios"; "operador" no. */
  rol: Rol;
  /** Clave pública VAPID para suscribir push (null si el server no tiene push). */
  vapidPublica: string | null;
  /** Catálogo de servicios agendables del negocio (para la Agenda, C2.1). */
  servicios: Service[];
  /** White-label (C4.1): color de acento/encabezado y logo del negocio. */
  marca: Marca;
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

/** Cola de trabajo (C2.3): marcar una conversación como atendida, o reabrirla. */
export async function cambiarEstadoConversacion(id: string, estado: EstadoConversacion): Promise<void> {
  await pedir(`/conversaciones/${encodeURIComponent(id)}/estado`, {
    method: "POST",
    body: JSON.stringify({ estado }),
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

export async function marcarNoShowPanel(id: string): Promise<void> {
  await pedir(`/citas/${encodeURIComponent(id)}/no-show`, { method: "POST" });
}

export async function reprogramarCitaPanel(id: string, fecha: string, hora: string): Promise<void> {
  await pedir(`/citas/${encodeURIComponent(id)}/reprogramar`, {
    method: "POST",
    body: JSON.stringify({ fecha, hora }),
  });
}

// ── Config del negocio (C2.2) ──
export interface ConfigNegocio {
  horario: Record<number, HorarioDia>;
  servicios: Service[];
  kb: KnowledgeBase;
  bloqueos: Bloqueo[];
  /** Link para pedir reseña de Google (Maps / "Escribir reseña"). "" = sin configurar. */
  linkResenas: string;
  /** Nombre de la plantilla MARKETING aprobada en Meta (C3.2). "" = sin configurar. */
  plantillaMarketing: string;
  /** Color de acento del panel (hex "#rrggbb", C4.1). "" = paleta default. */
  colorAcento: string;
  /** Color del encabezado del panel (hex "#rrggbb", C4.1). "" = paleta default. */
  colorHeader: string;
  /** URL del logo del negocio (C4.1). "" = se muestran las iniciales del nombre. */
  logoUrl: string;
}

export function obtenerConfig(): Promise<ConfigNegocio> {
  return pedir<ConfigNegocio>("/config");
}

export async function guardarConfig(config: ConfigNegocio): Promise<void> {
  await pedir("/config", { method: "POST", body: JSON.stringify(config) });
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
  /**
   * Alta vía Embedded Signup (C4.2): en vez de mandar el accessToken por el navegador,
   * se manda el handle que devolvió /admin/embedded-signup/conectar. El backend lo
   * canjea por el token (stasheado del lado del server) y por el phone_number_id.
   */
  tokenHandle?: string;
}

// ── Embedded Signup de Meta (ROADMAP C4.2) ──
/** Config pública para armar el popup (null si el server no tiene ES configurado). */
export interface EmbeddedSignupConfig {
  appId: string;
  configId: string;
  graphVersion: string;
}

export function adminEmbeddedSignupConfig(): Promise<{ configurado: boolean; config: EmbeddedSignupConfig | null }> {
  return pedir<{ configurado: boolean; config: EmbeddedSignupConfig | null }>("/admin/embedded-signup/config");
}

/** Canjea el resultado del popup por un handle de token (el token no vuelve al navegador). */
export function adminConectarWhatsapp(datos: {
  code: string;
  phoneNumberId: string;
  wabaId: string;
}): Promise<{ phoneNumberId: string; wabaId: string; tokenHandle: string; suscrito: boolean; registrado: boolean }> {
  return pedir("/admin/embedded-signup/conectar", { method: "POST", body: JSON.stringify(datos) });
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

// ── Usuarios del panel del negocio (ROADMAP C2.3, solo dueño) ──
export interface UsuarioTenant {
  id: string;
  usuario: string;
  rol: Rol;
  activo: boolean;
  creadoEn: string;
}

export function listarUsuarios(): Promise<UsuarioTenant[]> {
  return pedir<{ usuarios: UsuarioTenant[] }>("/usuarios").then((r) => r.usuarios);
}

export async function crearUsuario(usuario: string, password: string, rol: Rol): Promise<void> {
  await pedir("/usuarios", { method: "POST", body: JSON.stringify({ usuario, password, rol }) });
}

export async function actualizarUsuario(id: string, patch: { rol?: Rol; activo?: boolean }): Promise<void> {
  await pedir(`/usuarios/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(patch) });
}

// ── Campañas segmentadas (ROADMAP C3.2, solo dueño) ──
export interface NuevaCampania {
  nombre: string;
  mensaje: string;
  segmentoTipo: SegmentoFiltro["tipo"];
  dias?: number;
  servicioId?: string;
  meses?: number;
}

export interface PreviewSegmento {
  total: number;
  muestra: ClienteSegmento[];
}

export function listarCampanias(): Promise<Campania[]> {
  return pedir<{ campanias: Campania[] }>("/campanias").then((r) => r.campanias);
}

export function obtenerCampania(id: string): Promise<CampaniaConDetalle> {
  return pedir<{ campania: CampaniaConDetalle }>(`/campanias/${encodeURIComponent(id)}`).then((r) => r.campania);
}

export function crearCampania(datos: NuevaCampania): Promise<Campania> {
  return pedir<{ campania: Campania }>("/campanias", { method: "POST", body: JSON.stringify(datos) }).then(
    (r) => r.campania,
  );
}

export function previsualizarSegmento(filtro: SegmentoFiltro): Promise<PreviewSegmento> {
  const q = new URLSearchParams({ tipo: filtro.tipo });
  if (filtro.dias !== undefined) q.set("dias", String(filtro.dias));
  if (filtro.servicioId !== undefined) q.set("servicioId", filtro.servicioId);
  if (filtro.meses !== undefined) q.set("meses", String(filtro.meses));
  return pedir<PreviewSegmento>(`/campanias/segmento/preview?${q}`);
}

export function enviarCampania(id: string, programadaPara: string | null): Promise<Campania> {
  return pedir<{ campania: Campania }>(`/campanias/${encodeURIComponent(id)}/enviar`, {
    method: "POST",
    body: JSON.stringify({ programadaPara }),
  }).then((r) => r.campania);
}

export function cancelarCampania(id: string): Promise<Campania> {
  return pedir<{ campania: Campania }>(`/campanias/${encodeURIComponent(id)}/cancelar`, { method: "POST" }).then(
    (r) => r.campania,
  );
}
