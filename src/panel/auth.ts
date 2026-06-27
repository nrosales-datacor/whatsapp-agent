import crypto from "node:crypto";

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

/** Crea un token de sesión firmado para un negocio (va en una cookie). */
export function crearSesion(tenantId: string): string {
  const payload = `${tenantId}.${Date.now() + DURACION_MS}.${SESSION_VERSION}`;
  const firma = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}.${firma}`).toString("base64url");
}

/** Verifica el token de sesión y devuelve el tenantId, o null si es inválido/venció. */
export function verificarSesion(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const [tenantId, exp, ver, firma] = Buffer.from(token, "base64url").toString().split(".");
    if (!tenantId || !exp || !ver || !firma) return null;
    if (ver !== SESSION_VERSION) return null; // sesión de una versión anterior → fuera
    const esperada = crypto.createHmac("sha256", SECRET).update(`${tenantId}.${exp}.${ver}`).digest("hex");
    const a = Buffer.from(firma);
    const b = Buffer.from(esperada);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (Date.now() > Number(exp)) return null;
    return tenantId;
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
