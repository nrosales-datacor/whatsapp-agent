import crypto from "node:crypto";
import { promisify } from "node:util";
import type { Rol } from "../types";

// scrypt en su variante async (E6/BLOQUEANTE-10): la versión Sync bloquea el event loop
// ~50-150ms por invocación con los parámetros default. Este mismo proceso Node atiende
// también el webhook de WhatsApp de TODOS los tenants — bloquear el loop en el login
// congela el webhook de todo el mundo. `scrypt` con promisify libera el loop mientras
// la libuv thread-pool hace el trabajo pesado.
const scryptAsync = promisify(crypto.scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

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
export async function hashearPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await scryptAsync(password, salt, 64)).toString("hex");
  return `${salt}:${hash}`;
}

// Hash de una contraseña al azar: se usa para gastar el MISMO tiempo de scrypt
// cuando el usuario no existe, y así no filtrar qué tenants son válidos por timing.
// Top-level await: el paquete es "type": "module" (ESM), así que esto se resuelve
// antes de que termine de evaluarse este módulo — cualquier import de HASH_DUMMY
// (p. ej. desde router.ts) ya lo recibe resuelto, nunca una Promise pendiente.
export const HASH_DUMMY = await hashearPassword(crypto.randomBytes(16).toString("hex"));

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
export async function verificarPassword(password: string, guardado: string | undefined): Promise<boolean> {
  if (!guardado) return false;
  const [salt, hash] = guardado.split(":");
  if (!salt || !hash) return false;
  const calc = (await scryptAsync(password, salt, 64)).toString("hex");
  const a = Buffer.from(calc);
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Sesión decodificada de un operador del panel (C2.3: incluye quién y su rol). */
export interface SesionOperador {
  tenantId: string;
  usuarioId: string;
  rol: Rol;
  // Epoch del usuario en el momento en que se firmó este token (E13/ALTO-06). El caller
  // (sesionDeOperador, router.ts) lo compara contra el epoch VIGENTE de la cuenta: si no
  // coinciden, el token es de una sesión ya revocada (cambio de clave/rol/estado desde el
  // login) aunque la firma y la expiración sigan siendo válidas.
  epoch: number;
}

/**
 * Crea un token de sesión firmado para un operador (va en una cookie). Lleva tenantId +
 * usuarioId + rol (C2.3): el rol gatea qué puede ver/hacer en el panel (p. ej. "Mi
 * negocio" y la gestión de usuarios son solo para "dueno"). `epoch` es el sessionEpoch
 * vigente de la cuenta al momento del login (E13/ALTO-06): lo trae el token para que
 * sesionDeOperador pueda detectar sesiones revocadas sin volver a la base en cada request.
 */
export function crearSesion(tenantId: string, usuarioId: string, rol: Rol, epoch: number): string {
  const payload = `${tenantId}.${usuarioId}.${rol}.${epoch}.${Date.now() + DURACION_MS}.${SESSION_VERSION}`;
  const firma = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}.${firma}`).toString("base64url");
}

/**
 * Verifica el token de sesión y devuelve tenantId/usuarioId/rol/epoch, o null si es
 * inválido/venció. Cambiar el formato del payload (como acá, al agregar usuarioId/rol/epoch)
 * invalida sola cualquier sesión previa: los tokens viejos no calzan con el split nuevo.
 */
export function verificarSesion(token: string | undefined): SesionOperador | null {
  if (!token) return null;
  try {
    const [tenantId, usuarioId, rol, epoch, exp, ver, firma] = Buffer.from(token, "base64url").toString().split(".");
    if (!tenantId || !usuarioId || !rol || !epoch || !exp || !ver || !firma) return null;
    if (ver !== SESSION_VERSION) return null; // sesión de una versión anterior → fuera
    const esperada = crypto
      .createHmac("sha256", SECRET)
      .update(`${tenantId}.${usuarioId}.${rol}.${epoch}.${exp}.${ver}`)
      .digest("hex");
    const a = Buffer.from(firma);
    const b = Buffer.from(esperada);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (Date.now() > Number(exp)) return null;
    const epochNum = Number(epoch);
    if (!Number.isInteger(epochNum) || epochNum < 0) return null; // epoch corrupto/no numérico
    return { tenantId, usuarioId, rol: rol as Rol, epoch: epochNum };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sesión del SUPERADMIN (onboarding en /panel/admin). Es APARTE de la del operador:
// cookie distinta (panel_admin_sesion) y un marcador fijo en el payload (no es un
// tenantId). Reusa el mismo HMAC/SECRET. El superadmin se valida por .env
// (PANEL_SUPERADMIN_*), no vive en la base. (ROADMAP B3)
//
// Endurecida en la revisión de seguridad pre-venta 2026-10 (es la llave de TODOS los
// negocios: alta, baja con export, reset de claves, tokens de WhatsApp):
//   • Duración CORTA y configurable (`PANEL_ADMIN_SESSION_HORAS`, default 8 h, tope 12 h),
//     en vez de los 7 días de la sesión de operador.
//   • Versión PROPIA (`PANEL_ADMIN_SESSION_VERSION`): subirla echa solo al superadmin, sin
//     desloguear a todos los negocios (la global `PANEL_SESSION_VERSION` sigue aplicando).
//   • Marca de 2FA: si `PANEL_SUPERADMIN_TOTP_SECRET` está configurado, solo valen las
//     sesiones abiertas CON código TOTP — una cookie emitida antes de activar el 2FA deja
//     de servir en el acto.
// ─────────────────────────────────────────────────────────────────────────────
const ADMIN_MARCA = "__superadmin__";
const HORAS_ADMIN_MAX = 12;

function versionAdmin(): string {
  return process.env.PANEL_ADMIN_SESSION_VERSION ?? "1";
}

/** Duración de la sesión del superadmin, en segundos (también es el Max-Age de la cookie). */
export function duracionSesionAdminSeg(): number {
  const horas = Number(process.env.PANEL_ADMIN_SESSION_HORAS ?? 8);
  const h = Number.isFinite(horas) && horas > 0 ? Math.min(horas, HORAS_ADMIN_MAX) : 8;
  return Math.round(h * 60 * 60);
}

/** true si el superadmin tiene el segundo factor (TOTP) configurado: pasa a ser obligatorio. */
export function totpAdminConfigurado(): boolean {
  return !!process.env.PANEL_SUPERADMIN_TOTP_SECRET?.trim();
}

if (process.env.PANEL_SUPERADMIN_HASH && !totpAdminConfigurado() && process.env.NODE_ENV === "production") {
  console.warn(
    "[auth] El superadmin NO tiene segundo factor: configurá PANEL_SUPERADMIN_TOTP_SECRET (npx tsx scripts/generarTotp.ts).",
  );
}

function firmarAdmin(payload: string): string {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}

/** Crea el token de sesión del superadmin (va en la cookie panel_admin_sesion).
 *  `conTotp` = la sesión se abrió validando el segundo factor. */
export function crearSesionAdmin(conTotp = false): string {
  const exp = Date.now() + duracionSesionAdminSeg() * 1000;
  const payload = `${ADMIN_MARCA}.${exp}.${SESSION_VERSION}.${versionAdmin()}.${conTotp ? 1 : 0}`;
  return Buffer.from(`${payload}.${firmarAdmin(payload)}`).toString("base64url");
}

/** true si el token es una sesión de superadmin válida y vigente. */
export function verificarSesionAdmin(token: string | undefined): boolean {
  if (!token) return false;
  try {
    const partes = Buffer.from(token, "base64url").toString().split(".");
    if (partes.length !== 6) return false;
    const [marca, exp, ver, verAdmin, mfa, firma] = partes;
    if (marca !== ADMIN_MARCA || !exp || !firma) return false;
    if (ver !== SESSION_VERSION || verAdmin !== versionAdmin()) return false;
    const a = Buffer.from(firma);
    const b = Buffer.from(firmarAdmin(`${marca}.${exp}.${ver}.${verAdmin}.${mfa}`));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    if (totpAdminConfigurado() && mfa !== "1") return false; // abierta sin 2FA → ya no vale
    // Defensa extra: aunque la firma sea válida, nunca más de 12 h hacia adelante.
    const expNum = Number(exp);
    return Date.now() <= expNum && expNum - Date.now() <= HORAS_ADMIN_MAX * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

/**
 * Huella NO reversible de una IP (HMAC con el secreto de sesión, recortada) para el rastro
 * de auditoría: permite ver "este login vino del mismo lugar que el anterior / de uno
 * nuevo" sin guardar la IP en claro (wa_auditoria no guarda datos personales).
 */
export function huellaOrigen(ip: string): string {
  return crypto.createHmac("sha256", SECRET).update(`origen:${ip}`).digest("hex").slice(0, 12);
}
