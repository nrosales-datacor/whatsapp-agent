import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Sesión firmada del panel (cookie HMAC, stateless). Sin dependencias externas.
//
// En producción (NODE_ENV=production o si hay DATABASE_URL) PANEL_SESSION_SECRET es
// OBLIGATORIO: sin él se usaría un secreto al azar por arranque, que desloguea a todos en
// cada deploy y rompe los despliegues con varias instancias (cada una firmaría con un
// secreto distinto). En desarrollo se permite el secreto aleatorio.
// ─────────────────────────────────────────────────────────────────────────────

/** Rol de un miembro del equipo dentro de un negocio (PLAN-GESTION.md §4, `memberships.role`). */
export type Role = "owner" | "admin" | "front_desk" | "staff";

export const ROLES: readonly Role[] = ["owner", "admin", "front_desk", "staff"];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

const SECRET = loadSecret();
function loadSecret(): string {
  const s = process.env.PANEL_SESSION_SECRET;
  if (s && s.length >= 16) return s;
  const inProduction = process.env.NODE_ENV === "production" || !!process.env.DATABASE_URL;
  if (inProduction) {
    throw new Error(
      "PANEL_SESSION_SECRET es obligatorio en producción (cadena de 16+ caracteres). " +
        'Generá uno con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  console.warn(
    "[auth] PANEL_SESSION_SECRET sin configurar: uso un secreto aleatorio (las sesiones se reinician en cada arranque). Solo para desarrollo.",
  );
  return crypto.randomBytes(32).toString("hex");
}

// Subir PANEL_SESSION_VERSION invalida TODAS las sesiones vigentes sin cambiar el secreto
// (sirve para forzar un re-login global, ya que las sesiones son stateless).
const SESSION_VERSION = process.env.PANEL_SESSION_VERSION ?? "1";
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 días: ventana acotada si se filtra un token

function sign(payload: string): string {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}

function sameSignature(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Sesión decodificada de un miembro del equipo: de qué negocio, quién y con qué rol. */
export interface Session {
  tenantId: string;
  userId: string;
  role: Role;
  // Epoch del usuario en el momento en que se firmó el token. Quien valida la sesión lo
  // compara contra el epoch VIGENTE de la cuenta: si no coinciden, el token es de una
  // sesión ya revocada (cambio de clave/rol/estado desde el login) aunque la firma y la
  // expiración sigan siendo válidas.
  epoch: number;
}

/**
 * Crea un token de sesión firmado (va en una cookie). Lleva tenantId + userId + rol (el
 * rol gatea qué puede ver/hacer en el panel) y el `epoch` vigente de la cuenta al momento
 * del login, para detectar sesiones revocadas sin volver a la base en cada request.
 */
export function createSession(tenantId: string, userId: string, role: Role, epoch: number): string {
  const payload = `${tenantId}.${userId}.${role}.${epoch}.${Date.now() + SESSION_DURATION_MS}.${SESSION_VERSION}`;
  return Buffer.from(`${payload}.${sign(payload)}`).toString("base64url");
}

/**
 * Verifica el token de sesión y devuelve tenantId/userId/rol/epoch, o null si es inválido
 * o venció. Cambiar el formato del payload invalida sola cualquier sesión previa: los
 * tokens viejos no calzan con el split nuevo.
 */
export function verifySession(token: string | undefined): Session | null {
  if (!token) return null;
  try {
    const [tenantId, userId, role, epoch, exp, ver, signature] = Buffer.from(token, "base64url").toString().split(".");
    if (!tenantId || !userId || !role || !epoch || !exp || !ver || !signature) return null;
    if (ver !== SESSION_VERSION) return null; // sesión de una versión anterior → fuera
    if (!sameSignature(signature, sign(`${tenantId}.${userId}.${role}.${epoch}.${exp}.${ver}`))) return null;
    if (Date.now() > Number(exp)) return null;
    if (!isRole(role)) return null;
    const epochNum = Number(epoch);
    if (!Number.isInteger(epochNum) || epochNum < 0) return null; // epoch corrupto/no numérico
    return { tenantId, userId, role, epoch: epochNum };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sesión del SUPERADMIN (/panel/admin). Es APARTE de la del equipo: cookie distinta y un
// marcador fijo en el payload (no es un tenantId). Reusa el mismo HMAC/SECRET. El
// superadmin se valida por .env (PANEL_SUPERADMIN_*), no vive en la base.
//
// Endurecida porque es la llave de TODOS los negocios (alta, baja, reset de claves,
// tokens de WhatsApp):
//   • Duración CORTA y configurable (`PANEL_ADMIN_SESSION_HOURS`, default 8 h, tope 12 h),
//     en vez de los 7 días de la sesión del equipo.
//   • Versión PROPIA (`PANEL_ADMIN_SESSION_VERSION`): subirla echa solo al superadmin, sin
//     desloguear a todos los negocios (la global `PANEL_SESSION_VERSION` sigue aplicando).
//   • Marca de 2FA: si `PANEL_SUPERADMIN_TOTP_SECRET` está configurado, solo valen las
//     sesiones abiertas CON código TOTP — una cookie emitida antes de activar el 2FA deja
//     de servir en el acto.
// ─────────────────────────────────────────────────────────────────────────────
const ADMIN_MARKER = "__superadmin__";
const ADMIN_MAX_HOURS = 12;

function adminVersion(): string {
  return process.env.PANEL_ADMIN_SESSION_VERSION ?? "1";
}

/** Duración de la sesión del superadmin, en segundos (también es el Max-Age de la cookie). */
export function adminSessionSeconds(): number {
  const hours = Number(process.env.PANEL_ADMIN_SESSION_HOURS ?? 8);
  const h = Number.isFinite(hours) && hours > 0 ? Math.min(hours, ADMIN_MAX_HOURS) : 8;
  return Math.round(h * 60 * 60);
}

/** true si el superadmin tiene el segundo factor (TOTP) configurado: pasa a ser obligatorio. */
export function isAdminTotpConfigured(): boolean {
  return !!process.env.PANEL_SUPERADMIN_TOTP_SECRET?.trim();
}

if (process.env.PANEL_SUPERADMIN_HASH && !isAdminTotpConfigured() && process.env.NODE_ENV === "production") {
  console.warn(
    "[auth] El superadmin NO tiene segundo factor: configurá PANEL_SUPERADMIN_TOTP_SECRET (npx tsx scripts/generateTotp.ts).",
  );
}

/** Crea el token de sesión del superadmin. `withTotp` = la sesión se abrió validando el segundo factor. */
export function createAdminSession(withTotp = false): string {
  const exp = Date.now() + adminSessionSeconds() * 1000;
  const payload = `${ADMIN_MARKER}.${exp}.${SESSION_VERSION}.${adminVersion()}.${withTotp ? 1 : 0}`;
  return Buffer.from(`${payload}.${sign(payload)}`).toString("base64url");
}

/** true si el token es una sesión de superadmin válida y vigente. */
export function verifyAdminSession(token: string | undefined): boolean {
  if (!token) return false;
  try {
    const parts = Buffer.from(token, "base64url").toString().split(".");
    if (parts.length !== 6) return false;
    const [marker, exp, ver, adminVer, mfa, signature] = parts;
    if (marker !== ADMIN_MARKER || !exp || !signature) return false;
    if (ver !== SESSION_VERSION || adminVer !== adminVersion()) return false;
    if (!sameSignature(signature, sign(`${marker}.${exp}.${ver}.${adminVer}.${mfa}`))) return false;
    if (isAdminTotpConfigured() && mfa !== "1") return false; // abierta sin 2FA → ya no vale
    // Defensa extra: aunque la firma sea válida, nunca más de 12 h hacia adelante.
    const expNum = Number(exp);
    return Date.now() <= expNum && expNum - Date.now() <= ADMIN_MAX_HOURS * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

/**
 * Huella NO reversible de una IP (HMAC con el secreto de sesión, recortada) para el
 * rastro de auditoría: permite ver "este login vino del mismo lugar que el anterior / de
 * uno nuevo" sin guardar la IP en claro (audit_log no guarda datos personales).
 */
export function originFingerprint(ip: string): string {
  return crypto.createHmac("sha256", SECRET).update(`origin:${ip}`).digest("hex").slice(0, 12);
}
