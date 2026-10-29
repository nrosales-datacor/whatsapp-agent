import { PRODUCT_NAME } from "../brand";

// ─────────────────────────────────────────────────────────────────────────────
// Plantillas de correo en español (es-CR): HTML simple con estilos inline (lo único que
// respetan Gmail/Outlook) + versión en texto plano con el mismo contenido.
//
// Cada plantilla describe su contenido como PARTES de texto plano (título, párrafos,
// detalles, botones) y un solo renderizador arma el HTML y el texto. Así TODA
// interpolación pasa por `escapeHtml` en un único lugar: un nombre de negocio o de
// cliente con `<script>` o comillas no puede romper el HTML. Los links se validan
// (solo http/https: nada de `javascript:`).
//
// Registro: el equipo del negocio (invitación, clave) recibe voseo, como el panel; el
// cliente final (recordatorio, cita agendada) recibe "usted", lo más seguro para un
// consultorio o una clínica.
//
// Devuelven `{ subject, html, text }`: quien envía agrega `to` (y `tags`) y lo encola en
// el job "email.send" (./job.ts).
// ─────────────────────────────────────────────────────────────────────────────

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface BrandOptions {
  /** Nombre del negocio: va en el encabezado, el asunto y el pie. */
  businessName: string;
  /** Color de marca del negocio en hex ("#0b7d72" o "#0b7"); si falta o no es válido, el de la plataforma. */
  brandColor?: string | null;
  /** Logo del negocio (marca propia, I6.5): solo https; cualquier otra cosa se ignora y va el nombre solo. */
  logoUrl?: string | null;
}

/** Color de la plataforma (el acento del panel, web/src/global.css). */
export const DEFAULT_BRAND_COLOR = "#0b7d72";

const LOCALE = "es-CR";

// ── Utilidades ──

/** Escapa un valor para meterlo en HTML (texto o atributo entre comillas). */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Texto en una sola línea (sin saltos ni espacios repetidos): asuntos, nombres. */
function oneLine(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function required(value: string | null | undefined, field: string): string {
  const v = oneLine(value);
  if (!v) throw new Error(`Plantilla de correo: falta \`${field}\``);
  return v;
}

/** URL apta para un link de correo: solo http/https. Lanza sin mostrar la URL (puede llevar un token). */
/** Logo utilizable en un correo: solo https (un http lo bloquea el cliente de correo; otra cosa, nunca). */
function safeLogoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function safeUrl(url: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Plantilla de correo: \`${field}\` no es una URL válida`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Plantilla de correo: \`${field}\` debe ser http(s)`);
  }
  return parsed.href;
}

function optionalUrl(url: string | null | undefined, field: string): string | null {
  return url ? safeUrl(url, field) : null;
}

/** "#0b7" / "#0B7D72" → "#0b7d72", o el color de la plataforma si no es un hex válido. */
export function normalizeBrandColor(color: string | null | undefined): string {
  const c = String(color ?? "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{3}$/.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  return DEFAULT_BRAND_COLOR;
}

/** Luminancia relativa (WCAG 2.x) de un "#rrggbb". */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = "#ffffff";
const INK = "#111827";

/** Texto legible sobre el color de marca: blanco o casi negro, el que más contraste. */
function textOn(background: string): string {
  return contrast(background, WHITE) >= contrast(background, INK) ? WHITE : INK;
}

/** Vigencia legible: 30 → "30 minutos", 60 → "1 hora", 2880 → "2 días". */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("Plantilla de correo: la vigencia debe ser > 0 minutos");
  const m = Math.round(minutes);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (m >= 1440 && m % 1440 === 0) return plural(m / 1440, "día", "días");
  if (m >= 60 && m % 60 === 0) return plural(m / 60, "hora", "horas");
  if (m < 1440) return plural(m, "minuto", "minutos");
  return plural(Math.round(m / 60), "hora", "horas");
}

/**
 * Fecha y hora de una cita en la zona horaria de la SUCURSAL (no la del servidor ni la del
 * navegador): `{ date: "martes, 20 de octubre de 2026", time: "9:00 a. m." }`. Lanza si
 * la zona horaria no es válida: una hora equivocada en un recordatorio es peor que un
 * error visible.
 */
export function formatAppointmentDateTime(startsAt: Date, timeZone: string): { date: string; time: string } {
  if (!(startsAt instanceof Date) || Number.isNaN(startsAt.getTime())) {
    throw new Error("Plantilla de correo: fecha de la cita inválida");
  }
  let dateFormat: Intl.DateTimeFormat;
  let timeFormat: Intl.DateTimeFormat;
  try {
    dateFormat = new Intl.DateTimeFormat(LOCALE, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone });
    timeFormat = new Intl.DateTimeFormat(LOCALE, { hour: "numeric", minute: "2-digit", timeZone });
  } catch {
    throw new Error(`Plantilla de correo: zona horaria inválida "${oneLine(timeZone).slice(0, 64)}"`);
  }
  return { date: dateFormat.format(startsAt), time: timeFormat.format(startsAt) };
}

// ── Renderizador único ──

interface EmailAction {
  label: string;
  url: string;
  primary: boolean;
}

interface EmailParts {
  subject: string;
  brand: BrandOptions;
  /** Texto de vista previa en la bandeja (oculto en el cuerpo). */
  preheader: string;
  heading: string;
  paragraphs: string[];
  details?: Array<[label: string, value: string]>;
  actions?: EmailAction[];
  /** Letra chica bajo los botones (vigencia, "si no fuiste vos…"). */
  footnote?: string;
}

function footerText(businessName: string): string {
  return businessName === PRODUCT_NAME ? PRODUCT_NAME : `${businessName} · Enviado con ${PRODUCT_NAME}`;
}

function renderHtml(parts: EmailParts): string {
  const businessName = parts.brand.businessName;
  const brand = normalizeBrandColor(parts.brand.brandColor);
  const onBrand = textOn(brand);
  // Botón secundario: borde del color de marca y texto de ese color si se lee sobre blanco.
  const brandInk = contrast(brand, WHITE) >= 4.5 ? brand : INK;
  const e = escapeHtml;

  const paragraphs = parts.paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#1f2937;">${e(p)}</p>`)
    .join("");

  const details = parts.details?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;font-size:15px;line-height:1.5;">${parts.details
        .map(
          ([label, value]) =>
            `<tr><td style="padding:4px 16px 4px 0;color:#6b7280;vertical-align:top;white-space:nowrap;">${e(label)}</td>` +
            `<td style="padding:4px 0;color:${INK};vertical-align:top;">${e(value)}</td></tr>`,
        )
        .join("")}</table>`
    : "";

  const buttons = parts.actions?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr>${parts.actions
        .map((a, i) => {
          const gap = i > 0 ? `<td style="width:12px;font-size:0;line-height:0;">&nbsp;</td>` : "";
          const cell = a.primary
            ? `<td style="border-radius:6px;background:${brand};">` +
              `<a href="${e(a.url)}" target="_blank" style="display:inline-block;padding:12px 20px;font-size:15px;font-weight:bold;color:${onBrand};text-decoration:none;border-radius:6px;">${e(a.label)}</a></td>`
            : `<td style="border-radius:6px;border:1px solid ${brand};">` +
              `<a href="${e(a.url)}" target="_blank" style="display:inline-block;padding:11px 19px;font-size:15px;font-weight:bold;color:${brandInk};text-decoration:none;border-radius:6px;">${e(a.label)}</a></td>`;
          return gap + cell;
        })
        .join("")}</tr></table>`
    : "";

  // Link en claro bajo el botón principal: hay clientes de correo que bloquean botones.
  const primary = parts.actions?.find((a) => a.primary);
  const fallback = primary
    ? `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#6b7280;">¿El botón no funciona? Este es el enlace:<br>` +
      `<a href="${e(primary.url)}" target="_blank" style="color:${brandInk};word-break:break-all;">${e(primary.url)}</a></p>`
    : "";

  const footnote = parts.footnote
    ? `<p style="margin:0;font-size:13px;line-height:1.5;color:#6b7280;">${e(parts.footnote)}</p>`
    : "";

  // Marca propia: el logo del negocio a la izquierda del nombre (con alt: si el cliente de
  // correo bloquea imágenes, se lee el nombre igual).
  const logoUrl = safeLogoUrl(parts.brand.logoUrl);
  const logo = logoUrl
    ? `<img src="${e(logoUrl)}" alt="" height="32" style="height:32px;max-width:120px;vertical-align:middle;margin-right:12px;border:0;">`
    : "";

  return (
    `<!doctype html><html lang="es"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light">` +
    `<title>${e(parts.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#f4f5f7;">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${e(parts.preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7;"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:${WHITE};border-radius:8px;font-family:Arial,Helvetica,sans-serif;">` +
    `<tr><td style="background:${brand};color:${onBrand};padding:20px 24px;font-size:18px;font-weight:bold;border-radius:8px 8px 0 0;">${logo}${e(businessName)}</td></tr>` +
    `<tr><td style="padding:24px;">` +
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:${INK};">${e(parts.heading)}</h1>` +
    paragraphs +
    details +
    buttons +
    fallback +
    footnote +
    `</td></tr>` +
    `<tr><td style="padding:16px 24px;background:#f9fafb;font-size:12px;line-height:1.5;color:#6b7280;border-radius:0 0 8px 8px;">${e(footerText(businessName))}</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

function renderText(parts: EmailParts): string {
  const blocks: string[] = [parts.heading, ...parts.paragraphs];
  if (parts.details?.length) blocks.push(parts.details.map(([label, value]) => `${label}: ${value}`).join("\n"));
  if (parts.actions?.length) blocks.push(parts.actions.map((a) => `${a.label}: ${a.url}`).join("\n"));
  if (parts.footnote) blocks.push(parts.footnote);
  blocks.push(`—\n${footerText(parts.brand.businessName)}`);
  return `${blocks.join("\n\n")}\n`;
}

function render(parts: EmailParts): EmailContent {
  return { subject: oneLine(parts.subject), html: renderHtml(parts), text: renderText(parts) };
}

function brandOf(data: BrandOptions, field = "businessName"): BrandOptions {
  return { businessName: required(data.businessName, field), brandColor: data.brandColor, logoUrl: data.logoUrl };
}

function greeting(name: string | null | undefined): string {
  const n = oneLine(name);
  return n ? `Hola, ${n}` : "Hola";
}

// ── Equipo del negocio ──

export interface InvitationEmailData extends BrandOptions {
  /** Nombre de quien recibe la invitación. */
  inviteeName?: string | null;
  /** Nombre de quien invita (dueño o administrador). */
  invitedByName?: string | null;
  /** Link para aceptar la invitación y crear la clave. */
  acceptUrl: string;
  /** Minutos de vigencia del link, si vence. */
  expiresInMinutes?: number | null;
}

/** "Te invitaron a <negocio>": link para crear la clave y entrar al panel. */
export function invitationEmail(data: InvitationEmailData): EmailContent {
  const brand = brandOf(data);
  const business = brand.businessName;
  const acceptUrl = safeUrl(data.acceptUrl, "acceptUrl");
  const invitedBy = oneLine(data.invitedByName);
  const expires = data.expiresInMinutes ? `Este enlace vence en ${formatDuration(data.expiresInMinutes)}. ` : "";
  return render({
    subject: `Te invitaron a ${business} en ${PRODUCT_NAME}`,
    brand,
    preheader: `Creá tu clave para entrar al equipo de ${business}.`,
    heading: greeting(data.inviteeName),
    paragraphs: [
      invitedBy
        ? `${invitedBy} te invitó a unirte al equipo de ${business} en ${PRODUCT_NAME}.`
        : `Te invitaron a unirte al equipo de ${business} en ${PRODUCT_NAME}.`,
      "Para entrar, creá tu clave con el botón de abajo.",
    ],
    actions: [{ label: "Crear mi clave", url: acceptUrl, primary: true }],
    footnote: `${expires}Si no esperabas esta invitación, podés ignorar este correo.`,
  });
}

export interface PasswordResetEmailData {
  /** Negocio desde el que se pidió (opcional: la cuenta es de la plataforma). Sin él, el nombre del producto. */
  businessName?: string | null;
  brandColor?: string | null;
  userName?: string | null;
  /** Link para elegir la clave nueva. */
  resetUrl: string;
  /** Minutos de vigencia del link. */
  expiresInMinutes: number;
}

/** Recuperación de clave: link con vencimiento. */
export function passwordResetEmail(data: PasswordResetEmailData): EmailContent {
  const brand: BrandOptions = { businessName: oneLine(data.businessName) || PRODUCT_NAME, brandColor: data.brandColor };
  const resetUrl = safeUrl(data.resetUrl, "resetUrl");
  const expires = formatDuration(data.expiresInMinutes);
  return render({
    subject: `Restablecé tu clave de ${PRODUCT_NAME}`,
    brand,
    preheader: `El enlace para elegir una clave nueva vence en ${expires}.`,
    heading: greeting(data.userName),
    paragraphs: [
      `Recibimos un pedido para restablecer la clave de tu cuenta de ${PRODUCT_NAME}.`,
      "Para elegir una clave nueva, usá el botón de abajo.",
    ],
    actions: [{ label: "Elegir una clave nueva", url: resetUrl, primary: true }],
    footnote: `Este enlace vence en ${expires}. Si no pediste este cambio, ignorá este correo: tu clave actual sigue funcionando.`,
  });
}

// ── Alta self-service (I6.7) ──

export interface EmailVerificationEmailData {
  userName?: string | null;
  /** Negocio recién creado (va en el saludo; la marca es la del producto: todavía no hay otra). */
  businessName?: string | null;
  /** Link para confirmar el correo. */
  verifyUrl: string;
  /** Minutos de vigencia del link. */
  expiresInMinutes: number;
}

/** Confirmá tu correo: el último paso del registro antes de poder entrar. */
export function emailVerificationEmail(data: EmailVerificationEmailData): EmailContent {
  const brand: BrandOptions = { businessName: PRODUCT_NAME };
  const verifyUrl = safeUrl(data.verifyUrl, "verifyUrl");
  const expires = formatDuration(data.expiresInMinutes);
  const business = oneLine(data.businessName);
  return render({
    subject: `Confirmá tu correo para entrar a ${PRODUCT_NAME}`,
    brand,
    preheader: "Un clic y tu cuenta queda lista.",
    heading: greeting(data.userName),
    paragraphs: [
      business
        ? `Creaste la cuenta de ${business} en ${PRODUCT_NAME}. Para entrar, confirmá que este correo es tuyo.`
        : `Creaste una cuenta en ${PRODUCT_NAME}. Para entrar, confirmá que este correo es tuyo.`,
    ],
    actions: [{ label: "Confirmar mi correo", url: verifyUrl, primary: true }],
    footnote: `Este enlace vence en ${expires}. Si no creaste esta cuenta, ignorá este correo: sin confirmar, nadie puede entrar con ella.`,
  });
}

export interface SignupAttemptEmailData {
  userName?: string | null;
  /** Link al login del panel. */
  loginUrl: string;
  /** Link a "olvidé mi clave". */
  forgotUrl: string;
}

/**
 * Alguien quiso registrarse con un correo que ya tiene cuenta. La respuesta del registro es
 * la misma exista o no (no es un oráculo de cuentas): el aviso llega solo al dueño del correo.
 */
export function signupAttemptEmail(data: SignupAttemptEmailData): EmailContent {
  const brand: BrandOptions = { businessName: PRODUCT_NAME };
  return render({
    subject: `Ya tenés una cuenta en ${PRODUCT_NAME}`,
    brand,
    preheader: "Alguien quiso crear una cuenta nueva con este correo.",
    heading: greeting(data.userName),
    paragraphs: [
      `Alguien (quizás vos) quiso crear una cuenta nueva en ${PRODUCT_NAME} con este correo, pero ya tenés una.`,
      "Entrá con tu clave de siempre o, si no la recordás, elegí una nueva.",
    ],
    actions: [
      { label: "Entrar", url: safeUrl(data.loginUrl, "loginUrl"), primary: true },
      { label: "Olvidé mi clave", url: safeUrl(data.forgotUrl, "forgotUrl"), primary: false },
    ],
    footnote: "Si no fuiste vos, no tenés que hacer nada: tu cuenta sigue igual.",
  });
}

// ── Cliente final ──

export interface AppointmentEmailData extends BrandOptions {
  clientName: string;
  /** Nombres de los servicios de la cita (copia de `appointment_services.name`). */
  services: string[];
  startsAt: Date;
  /** Zona horaria IANA de la sucursal (`locations.timezone`), p. ej. "America/Costa_Rica". */
  timeZone: string;
  locationName: string;
  locationAddress?: string | null;
  staffName?: string | null;
}

export interface AppointmentReminderEmailData extends AppointmentEmailData {
  confirmUrl?: string | null;
  cancelUrl?: string | null;
}

export interface AppointmentConfirmationEmailData extends AppointmentEmailData {
  cancelUrl?: string | null;
}

/** Filas de detalle de una cita (servicios, fecha y hora en la zona de la sucursal, profesional, sucursal). */
function appointmentDetails(data: AppointmentEmailData): {
  details: Array<[string, string]>;
  when: { date: string; time: string };
  locationName: string;
} {
  const when = formatAppointmentDateTime(data.startsAt, data.timeZone);
  const locationName = required(data.locationName, "locationName");
  const services = (data.services ?? []).map(oneLine).filter(Boolean);
  const details: Array<[string, string]> = [];
  if (services.length) details.push([services.length === 1 ? "Servicio" : "Servicios", services.join(", ")]);
  details.push(["Fecha", when.date], ["Hora", when.time]);
  const staff = oneLine(data.staffName);
  if (staff) details.push(["Profesional", staff]);
  details.push(["Sucursal", locationName]);
  const address = oneLine(data.locationAddress);
  if (address) details.push(["Dirección", address]);
  return { details, when, locationName };
}

function cancelFootnote(hasCancelLink: boolean): string {
  return hasCancelLink
    ? "Si no puede asistir, cancele con anticipación para liberar el espacio."
    : "Si necesita cambiar o cancelar su cita, comuníquese con el negocio.";
}

/** Recordatorio de cita, con links opcionales para confirmar o cancelar. */
export function appointmentReminderEmail(data: AppointmentReminderEmailData): EmailContent {
  const brand = brandOf(data);
  const business = brand.businessName;
  const { details, when, locationName } = appointmentDetails(data);
  const confirmUrl = optionalUrl(data.confirmUrl, "confirmUrl");
  const cancelUrl = optionalUrl(data.cancelUrl, "cancelUrl");
  const actions: EmailAction[] = [];
  if (confirmUrl) actions.push({ label: "Confirmar asistencia", url: confirmUrl, primary: true });
  if (cancelUrl) actions.push({ label: "Cancelar cita", url: cancelUrl, primary: false });
  return render({
    subject: `Recordatorio de su cita en ${business}`,
    brand,
    preheader: `${when.date}, ${when.time} · ${locationName}`,
    heading: greeting(required(data.clientName, "clientName")),
    paragraphs: [
      `Le recordamos su cita en ${business}.`,
      ...(confirmUrl ? ["Por favor confirme su asistencia con el botón de abajo."] : []),
    ],
    details,
    actions,
    footnote: cancelFootnote(Boolean(cancelUrl)),
  });
}

/** Cita agendada: los detalles y, si hay, el link para cancelar. */
export function appointmentConfirmationEmail(data: AppointmentConfirmationEmailData): EmailContent {
  const brand = brandOf(data);
  const business = brand.businessName;
  const { details, when, locationName } = appointmentDetails(data);
  const cancelUrl = optionalUrl(data.cancelUrl, "cancelUrl");
  return render({
    subject: `Su cita en ${business} quedó agendada`,
    brand,
    preheader: `${when.date}, ${when.time} · ${locationName}`,
    heading: greeting(required(data.clientName, "clientName")),
    paragraphs: [`Su cita en ${business} quedó agendada. Estos son los detalles:`],
    details,
    actions: cancelUrl ? [{ label: "Cancelar cita", url: cancelUrl, primary: false }] : [],
    footnote: cancelFootnote(Boolean(cancelUrl)),
  });
}
