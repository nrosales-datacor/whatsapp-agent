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
  Empleado,
  EstadoConversacion,
  FichaCliente,
  HorarioDia,
  KnowledgeBase,
  Metricas,
  ModoConversacion,
  Plan,
  Rol,
  ResumenConversacion,
  SeccionConocimiento,
  SegmentoFiltro,
  Service,
} from "../../src/types";
import { desuscribirPushLocal, endpointPushLocal } from "./lib/pushLocal";

export type {
  Bloqueo,
  Campania,
  CampaniaConDetalle,
  Cita,
  ClienteSegmento,
  Conversacion,
  Empleado,
  EstadoConversacion,
  FichaCliente,
  HorarioDia,
  KnowledgeBase,
  Metricas,
  ModoConversacion,
  Plan,
  Rol,
  ResumenConversacion,
  SeccionConocimiento,
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
    /** Código de máquina opcional del backend (ej. "cuenta_pausada"). */
    public codigo?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** true si el error es "no autenticado" (401) → el caller debe mandar al login. */
export function esNoAutenticado(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 401;
}

/** true si el negocio está pausado por la plataforma (falta de pago): el panel muestra
 * "cuenta pausada, contactá a Selyon" en vez del login o de un error genérico. */
export function esCuentaPausada(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 403 && e.codigo === "cuenta_pausada";
}

// Sobre del backend: éxito trae { ok:true, ...datos }; error trae { ok:false, error, codigo? }.
type Respuesta<T> = ({ ok: true } & T) | { ok: false; error: string; codigo?: string };

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
    const codigo = cuerpo && cuerpo.ok === false ? cuerpo.codigo : undefined;
    throw new ApiError(res.status, msg, path, codigo);
  }
  return cuerpo as T;
}

/** White-label por tenant (ROADMAP C4.1). Todo null = paleta verde default del panel. */
export interface Marca {
  colorAcento: string | null;
  colorHeader: string | null;
  logoUrl: string | null;
}

/** Features gateadas por plan (Carril D, 0.1). Ver src/billing/planes.ts. */
export interface Features {
  campanias: boolean;
  multiUsuario: boolean;
  whiteLabel: boolean;
  rescateCotizaciones: boolean;
  upsell: boolean;
  resenasPro: boolean;
}

// ── Tipos de respuesta que enriquecen los del dominio ──
export interface Sesion {
  nombre: string;
  tenantId: string;
  /** Id del usuario logueado (para que "Usuarios" pueda identificar la propia fila y evitar auto-lockout). */
  usuarioId: string;
  /** Rol del usuario logueado (C2.3): "dueno" ve "Mi negocio" y "Usuarios"; "operador" no. */
  rol: Rol;
  /** Reset de contraseña desde el admin (Carril D, 0.5): fuerza la pantalla de cambio de clave. */
  debeCambiarClave: boolean;
  /** Clave pública VAPID para suscribir push (null si el server no tiene push). */
  vapidPublica: string | null;
  /** Catálogo de servicios agendables del negocio (para la Agenda, C2.1). */
  servicios: Service[];
  /** Moneda del negocio (E11): símbolo ("₡") o código ISO ("USD"). Opcional: un backend viejo no la manda. */
  moneda?: string;
  /**
   * Quiénes atienden (ALTO-07), para los carriles y el selector de la Agenda. Incluye
   * los inactivos: una cita vieja puede estar asignada a alguien que ya no atiende y
   * hay que poder mostrar su nombre igual. Vacío = negocio de un solo recurso.
   */
  empleados: Empleado[];
  /** White-label (C4.1): color de acento/encabezado y logo del negocio. */
  marca: Marca;
  /** Plan de suscripción del negocio (Carril D): "basico" | "pro". */
  plan: Plan;
  /** Qué puede usar este negocio según su plan — el panel muestra/oculta sin adivinar. */
  features: Features;
  /** Ventana de 24h (Carril D, 0.3): true si el negocio configuró la plantilla de
   * reapertura — habilita el botón "Reabrir conversación" fuera de ventana. */
  reaperturaConfigurada: boolean;
  /** Tope mensual de conversaciones (F10). Opcional: un backend viejo no lo manda. */
  cuotaMensual?: CuotaMensual;
  /** Contacto de la plataforma para "Mejorar plan" (sin pasarela de pago todavía). */
  contactoPlataforma?: ContactoPlataforma;
  /** Tope mensual de gasto de IA (USD). Al excederse el bot se pausa igual que con la cuota. */
  gastoLlmMensual?: { topeUsd: number | null; porcentaje: number | null; alcanzo80: boolean; excedido: boolean };
}

/** Estado del tope mensual de conversaciones del negocio (ver src/observabilidad/cuotas.ts). */
export interface CuotaMensual {
  /** null = sin tope (plan Pro o interruptor del superadmin). */
  tope: number | null;
  usados: number;
  porcentaje: number | null;
  alcanzo80: boolean;
  excedido: boolean;
}

/** A dónde manda el botón "Mejorar plan": WhatsApp (solo dígitos) y/o correo. */
export interface ContactoPlataforma {
  whatsapp: string | null;
  email: string | null;
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
  // Revisión de seguridad 2026-10: al salir, este dispositivo deja de recibir los avisos
  // push (el backend borra su suscripción y acá se da de baja en el navegador).
  const endpoint = await endpointPushLocal();
  try {
    await pedir("/logout", { method: "POST", body: JSON.stringify(endpoint ? { endpoint } : {}) });
  } finally {
    if (endpoint) await desuscribirPushLocal();
  }
}

export function me(): Promise<Sesion> {
  return pedir<Sesion>("/me");
}

/** Cambio de clave propio (Carril D, 0.5): lo usa el cambio obligatorio tras un reset del admin. */
export async function cambiarClave(claveActual: string, claveNueva: string): Promise<void> {
  await pedir("/cambiar-clave", { method: "POST", body: JSON.stringify({ claveActual, claveNueva }) });
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

/** Ventana de 24h (Carril D, 0.3): reabre la conversación con la plantilla de utilidad configurada. */
export async function reabrirConversacion(id: string): Promise<void> {
  await pedir(`/conversaciones/${encodeURIComponent(id)}/reabrir`, { method: "POST" });
}

/** Le manda al cliente el pedido de permiso de promociones (botones Sí/No). Requiere ventana de 24h abierta. */
export async function pedirConsentimiento(id: string): Promise<void> {
  await pedir(`/conversaciones/${encodeURIComponent(id)}/pedir-consentimiento`, { method: "POST" });
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
  /** Horas con al menos alguien libre (con equipo, la unión de todo el equipo). */
  libres: string[];
  /** Por cada hora libre, quiénes la pueden tomar (ALTO-07). `empleados` vacío = sin equipo cargado. */
  espacios: { hora: string; empleados: string[] }[];
  ocupadas: { hora: string; citaId: string; clienteNombre: string; empleadoId?: string }[];
}

export interface DatosCitaManual {
  clienteNombre: string;
  clienteWa: string;
  servicioId: string;
  fecha: string;
  hora: string;
  /** Quién atiende (ALTO-07). Omitir para dejarla sin asignar. */
  empleadoId?: string;
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

/** Reasigna la cita a otra persona (ALTO-07). `empleadoId` vacío la deja sin asignar. */
export async function asignarCitaPanel(id: string, empleadoId: string): Promise<void> {
  await pedir(`/citas/${encodeURIComponent(id)}/asignar`, {
    method: "POST",
    body: JSON.stringify({ empleadoId }),
  });
}

// ── Config del negocio (C2.2) ──
export interface ConfigNegocio {
  horario: Record<number, HorarioDia>;
  servicios: Service[];
  kb: KnowledgeBase;
  bloqueos: Bloqueo[];
  /** Quiénes atienden (ALTO-07). Vacío = el negocio atiende como un solo recurso. */
  empleados: Empleado[];
  /** Link para pedir reseña de Google (Maps / "Escribir reseña"). "" = sin configurar. */
  linkResenas: string;
  /** Nombre de la plantilla MARKETING aprobada en Meta (C3.2). "" = sin configurar. */
  plantillaMarketing: string;
  /** Nombre de la plantilla de UTILIDAD para reabrir conversaciones fuera de ventana (0.3). "" = sin configurar. */
  plantillaReapertura: string;
  /**
   * Nombre de la plantilla de recordatorio de cita aprobada en Meta (E8/BLOQ-06). "" =
   * sin configurar → el recordatorio cae a texto libre con botones.
   */
  plantillaRecordatorio: string;
  /**
   * Idioma (locale de Meta) con el que se aprobaron las plantillas de este negocio
   * (E8/BLOQ-06), ej: "es", "es_MX", "en_US". "" = usa el default del servidor.
   */
  plantillaIdioma: string;
  /** Color de acento del panel (hex "#rrggbb", C4.1). "" = paleta default. */
  colorAcento: string;
  /** Color del encabezado del panel (hex "#rrggbb", C4.1). "" = paleta default. */
  colorHeader: string;
  /** URL del logo del negocio (C4.1). "" = se muestran las iniciales del nombre. */
  logoUrl: string;
  /** Rescate de cotizaciones abandonadas (Carril D, 1.1): on/off. */
  rescateActivo: boolean;
  /** Horas sin cita antes del primer toque de seguimiento. */
  rescateHorasEspera: number;
  /** Texto editable del primer toque (lista de horarios, dentro de 24h). "" = usa el default. */
  rescateToque1Texto: string;
  /** Texto/variable editable del segundo toque (plantilla, fuera de 24h). "" = usa el default. */
  rescateToque2Texto: string;
  /** Nombre de la plantilla de Meta del segundo toque. "" = sin configurar (se detiene tras el primer toque). */
  rescatePlantilla: string;
  /** Place ID de Google (Carril D, 1.3-c): habilita el job diario de reputación. "" = sin configurar. */
  googlePlaceId: string;
  /**
   * ID del Google Calendar DEL NEGOCIO (auditoría BLOQ-05). "" = sin configurar (no se
   * sincroniza nada con Calendar; las citas viven en el panel igual).
   */
  googleCalendarId: string;
  /**
   * Solo lectura: la service account a la que el dueño debe compartir su calendario.
   * "" = la integración no está habilitada en el servidor. Opcional porque este tipo
   * describe tanto la respuesta del GET como el cuerpo del POST, y este campo solo
   * viaja de vuelta (el POST lo ignora).
   */
  calendarioServiceAccount?: string;
  // ── Perfil del negocio (B7, motor multi-mercado) ──
  /** Rubro/persona: "una barbería", "una empresa de software". "" = "un negocio". */
  tipoNegocio: string;
  /** País del negocio. "" = se infiere de la zona horaria. */
  pais: string;
  /** Formas de pago (texto libre). "" = no se menciona. */
  formasPago: string;
  /** Trato al cliente: "vos" | "tu" | "usted". "" = se infiere del país. */
  registro: string;
  /** Tono/estilo del bot (texto corto). "" = default "cordial y breve". */
  tono: string;
  /** Instrucciones libres del dueño para el bot (reglas particulares). "" = ninguna. */
  instrucciones: string;
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
  plan: Plan;
  /** Conversaciones iniciadas este mes (Carril D, 0.2) — mide sin bloquear, sin tope todavía. */
  conversacionesEsteMes: number;
  /** Tokens de OpenAI (entrada + salida) consumidos este mes (F13). */
  tokensEsteMes: number;
  /** Costo estimado de OpenAI este mes, en USD (F13) — ver AUDIT.md § 7 para las tarifas usadas. */
  costoUsdEsteMes: number;
  /** false = pausado por la plataforma (cobro manual): el bot no responde. */
  activo: boolean;
  /** ISO de la última pausa y su motivo (solo si está pausado). */
  pausadoDesde: string | null;
  motivoPausa: string | null;
  /** ¿Puede enviar por WhatsApp? (token propio o el legado del piloto). Nunca expone el token. */
  whatsappConectado: boolean;
  /** true si envía con el token GLOBAL del piloto en vez del suyo propio. */
  whatsappTokenGlobal: boolean;
}

/** Entrada del registro auditable de un negocio (pausas, reconexiones, borrados). */
export interface EntradaAuditoria {
  id: string;
  accion: string;
  actor: string;
  detalle: Record<string, unknown>;
  creadoEn: string;
}

/** Resultado de borrar los datos de un cliente: solo conteos, nada del cliente. */
export interface ResultadoBorradoCliente {
  conteos: Record<string, number>;
  archivosStorage: number;
  eventosCalendario: number;
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
    // Perfil del negocio (B7): opcionales; el backend los valida/normaliza igual.
    tipoNegocio?: string;
    pais?: string;
    formasPago?: string;
    registro?: string;
    tono?: string;
    instrucciones?: string;
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

/** `codigo`: los 6 dígitos de la app autenticadora (obligatorio si el server tiene TOTP configurado). */
export function adminLogin(usuario: string, password: string, codigo: string) {
  return pedir("/admin/login", { method: "POST", body: JSON.stringify({ usuario, password, codigo }) });
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

/** Cambia el plan de un negocio (Carril D, 0.1) — sin redeploy, vía el caché del tenantStore. */
export async function adminCambiarPlan(id: string, plan: Plan): Promise<void> {
  await pedir(`/admin/tenants/${encodeURIComponent(id)}/plan`, { method: "POST", body: JSON.stringify({ plan }) });
}

// ── Acciones de plataforma sobre un negocio (revisión pre-venta 2026-10) ──
const rutaTenant = (id: string) => `/admin/tenants/${encodeURIComponent(id)}`;

export async function adminPausarTenant(id: string, motivo: string): Promise<void> {
  await pedir(`${rutaTenant(id)}/pausar`, { method: "POST", body: JSON.stringify({ motivo }) });
}

export async function adminReactivarTenant(id: string, motivo: string): Promise<void> {
  await pedir(`${rutaTenant(id)}/reactivar`, { method: "POST", body: JSON.stringify({ motivo }) });
}

/** Carga/rota phone_number_id + token (o el handle de Embedded Signup). El token no vuelve. */
export async function adminReconectarWhatsapp(
  id: string,
  datos: { phoneNumberId?: string; accessToken?: string; tokenHandle?: string },
): Promise<void> {
  await pedir(`${rutaTenant(id)}/whatsapp`, { method: "POST", body: JSON.stringify(datos) });
}

/** Manda un texto de prueba con el token vigente. Si Graph falla, el error trae su mensaje. */
export async function adminProbarWhatsapp(id: string, para: string): Promise<void> {
  await pedir(`${rutaTenant(id)}/whatsapp/probar`, { method: "POST", body: JSON.stringify({ para }) });
}

export function adminBorrarCliente(id: string, clienteWa: string, confirmar: string): Promise<ResultadoBorradoCliente> {
  return pedir(`${rutaTenant(id)}/clientes/borrar`, { method: "POST", body: JSON.stringify({ clienteWa, confirmar }) });
}

export function adminAuditoriaTenant(id: string): Promise<EntradaAuditoria[]> {
  return pedir<{ auditoria: EntradaAuditoria[] }>(`${rutaTenant(id)}/auditoria`).then((r) => r.auditoria);
}

/** Borra TODOS los datos del cliente de esta conversación (solo dueño). `confirmar` = su teléfono. */
export function borrarCliente(convId: string, confirmar: string): Promise<ResultadoBorradoCliente> {
  return pedir(`/conversaciones/${encodeURIComponent(convId)}/borrar-cliente`, {
    method: "POST",
    body: JSON.stringify({ confirmar }),
  });
}

// ── Usuarios del panel del negocio (ROADMAP C2.3, solo dueño) ──
export interface UsuarioTenant {
  id: string;
  usuario: string;
  rol: Rol;
  activo: boolean;
  creadoEn: string;
  /** true si tiene una clave temporal pendiente de cambiar (reset del admin, 0.5). */
  debeCambiarClave: boolean;
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

// ── Reset de contraseña desde el admin (Carril D, 0.5) ──
export function adminListarUsuariosTenant(tenantId: string): Promise<UsuarioTenant[]> {
  return pedir<{ usuarios: UsuarioTenant[] }>(`/admin/tenants/${encodeURIComponent(tenantId)}/usuarios`).then((r) => r.usuarios);
}

export function adminResetearClave(usuarioId: string): Promise<{ usuario: string; claveTemporal: string; expiraEn: string }> {
  return pedir(`/admin/usuarios/${encodeURIComponent(usuarioId)}/reset-password`, { method: "POST" });
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
  /** Destinatarios reales: califican, dieron consentimiento de marketing y no pidieron la baja. */
  total: number;
  muestra: ClienteSegmento[];
  /** Califican por el filtro pero nunca dieron permiso de promociones (no reciben la campaña). */
  sinConsentimiento: number;
  /** Califican por el filtro pero pidieron la baja (no reciben la campaña). */
  conBaja: number;
}

/** Consentimiento de marketing del negocio: cuántos clientes dieron permiso de promociones. */
export interface ResumenConsentimiento {
  clientes: number;
  conConsentimiento: number;
  conBaja: number;
}

export function obtenerResumenConsentimiento(): Promise<ResumenConsentimiento> {
  return pedir<ResumenConsentimiento>("/campanias/consentimiento");
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
