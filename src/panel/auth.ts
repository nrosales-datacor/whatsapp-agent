import crypto from "node:crypto";
import type { Rol } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Autenticación del panel: contraseña por negocio (hash scrypt) + sesión firmada
// (cookie HMAC, stateless). Sin dependencias externas.
// ─────────────────────────────────────────────────────────────────────────────

// En producción (NODE_ENV=production o si hay DATABASE_URL) PANEL_SESSION_SECRET es
// OBLIGATORIO: sin él se usaría un secreto al azar por arranque, que desloguea a
// todos en cada deploy y rompe los despliegues con varias instancias (cada una
// firmaría con un secreto distinto). En desarrollo se permite el secreto aleatorio.
const SECRET = obtenerSecret();
function obtenerSecret(): string {
  const s = process.env.PANEL_SESSION_SECRET;
  if (s && s.length >= 16) return s;
  const enProd = process.env.NODE_ENV === "production" || !!process.env.DATABASE_URL;
  if (enProd) {
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

// Subir PANEL_SESSION_VERSION invalida TODAS las sesiones vigentes sin cambiar el
// secreto (sirve para forzar un re-login global, ya que las sesiones son stateless).
const SESSION_VERSION = process.env.PANEL_SESSION_VERSION ?? "1";
const DURACION_MS = 7 * 24 * 60 * 60 * 1000; // 7 días (antes 30: menor ventana si se filtra un token)

/** Genera "salt:hash" para guardar la contraseña del panel de un negocio. */
export function hashearPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

// Hash de una contraseña al azar: se usa para gastar el MISMO tiempo de scrypt
// cuando el usuario no existe, y así no filtrar qué tenants son válidos por timing.
export const HASH_DUMMY = hashearPassword(crypto.randomBytes(16).toString("hex"));

// Alfabeto sin caracteres ambiguos (0/O, 1/l/I) — la clave temporal (0.5) la lee/tipea
// un humano para comunicarla al dueño del negocio.
const ALFABETO_CLAVE_TEMPORAL = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

/** Genera una clave temporal legible (12 caracteres) para el reset de contraseña desde el admin. */
export function generarClaveTemporal(): string {
  const bytes = crypto.randomBytes(12);
  let out = "";
  for (const b of bytes) out += ALFABETO_CLAVE_TEMPORAL[b % ALFABETO_CLAVE_TEMPORAL.length];
  return out;
}

/** Compara una contraseña con el "salt:hash" guardado (tiempo constante). */
export function verificarPassword(password: string, guardado: string | undefined): boolean {
  if (!guardado) return false;
  const [salt, hash] = guardado.split(":");
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(calc);
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Sesión decodificada de un operador del panel (C2.3: incluye quién y su rol). */
export interface SesionOperador {
  tenantId: string;
  usuarioId: string;
  rol: Rol;
}

/**
 * Crea un token de sesión firmado para un operador (va en una cookie). Lleva tenantId +
 * usuarioId + rol (C2.3): el rol gatea qué puede ver/hacer en el panel (p. ej. "Mi
 * negocio" y la gestión de usuarios son solo para "dueno").
 */
export function crearSesion(tenantId: string, usuarioId: string, rol: Rol): string {
  const payload = `${tenantId}.${usuarioId}.${rol}.${Date.now() + DURACION_MS}.${SESSION_VERSION}`;
  const firma = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}.${firma}`).toString("base64url");
}

/**
 * Verifica el token de sesión y devuelve tenantId/usuarioId/rol, o null si es
 * inválido/venció. Cambiar el formato del payload (como acá, al agregar usuarioId/rol)
 * invalida sola cualquier sesión previa: los tokens viejos no calzan con el split nuevo.
 */
export function verificarSesion(token: string | undefined): SesionOperador | null {
  if (!token) return null;
  try {
    const [tenantId, usuarioId, rol, exp, ver, firma] = Buffer.from(token, "base64url").toString().split(".");
    if (!tenantId || !usuarioId || !rol || !exp || !ver || !firma) return null;
    if (ver !== SESSION_VERSION) return null; // sesión de una versión anterior → fuera
    const esperada = crypto
      .createHmac("sha256", SECRET)
      .update(`${tenantId}.${usuarioId}.${rol}.${exp}.${ver}`)
      .digest("hex");
    const a = Buffer.from(firma);
    const b = Buffer.from(esperada);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (Date.now() > Number(exp)) return null;
    return { tenantId, usuarioId, rol: rol as Rol };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sesión del SUPERADMIN (onboarding en /panel/admin). Es APARTE de la del operador:
// cookie distinta (panel_admin_sesion) y un marcador fijo en el payload (no es un
// tenantId). Reusa el mismo HMAC/SECRET/duración/versión. El superadmin se valida
// por .env (PANEL_SUPERADMIN_*), no vive en la base. (ROADMAP B3)
// ─────────────────────────────────────────────────────────────────────────────
const ADMIN_MARCA = "__superadmin__";

/** Crea el token de sesión del superadmin (va en la cookie panel_admin_sesion). */
export function crearSesionAdmin(): string {
  const payload = `${ADMIN_MARCA}.${Date.now() + DURACION_MS}.${SESSION_VERSION}`;
  const firma = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}.${firma}`).toString("base64url");
}

/** true si el token es una sesión de superadmin válida y vigente. */
export function verificarSesionAdmin(token: string | undefined): boolean {
  if (!token) return false;
  try {
    const [marca, exp, ver, firma] = Buffer.from(token, "base64url").toString().split(".");
    if (marca !== ADMIN_MARCA || !exp || !ver || !firma) return false;
    if (ver !== SESSION_VERSION) return false;
    const esperada = crypto.createHmac("sha256", SECRET).update(`${marca}.${exp}.${ver}`).digest("hex");
    const a = Buffer.from(firma);
    const b = Buffer.from(esperada);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    return Date.now() <= Number(exp);
  } catch {
    return false;
  }
}
