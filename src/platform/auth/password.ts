import crypto from "node:crypto";
import { promisify } from "node:util";

// ─────────────────────────────────────────────────────────────────────────────
// Contraseñas: hash scrypt ("salt:hash" en hex) y verificación en tiempo constante.
// Sin dependencias externas.
//
// scrypt en su variante async: la versión Sync bloquea el event loop ~50-150 ms por
// invocación con los parámetros default. Este mismo proceso Node atiende también los
// webhooks y la API de TODOS los negocios — bloquear el loop en un login congela a todo
// el mundo. `scrypt` con promisify libera el loop mientras el thread-pool de libuv hace
// el trabajo pesado.
// ─────────────────────────────────────────────────────────────────────────────

const scryptAsync = promisify(crypto.scrypt) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

/** Genera "salt:hash" para guardar una contraseña. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await scryptAsync(password, salt, 64)).toString("hex");
  return `${salt}:${hash}`;
}

// Hash de una contraseña al azar: se usa para gastar el MISMO tiempo de scrypt cuando el
// usuario no existe, y así no filtrar por timing qué cuentas son válidas. Top-level
// await: el paquete es ESM, así que esto se resuelve antes de que termine de evaluarse el
// módulo — cualquier import de DUMMY_HASH ya lo recibe resuelto, nunca una Promise.
export const DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString("hex"));

// Alfabeto sin caracteres ambiguos (0/O, 1/l/I): la clave temporal la lee/tipea un humano
// para comunicarla al dueño del negocio.
const TEMPORARY_PASSWORD_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

/** Genera una clave temporal legible (12 caracteres) para un reset de contraseña asistido. */
export function generateTemporaryPassword(): string {
  const bytes = crypto.randomBytes(12);
  let out = "";
  for (const b of bytes) out += TEMPORARY_PASSWORD_ALPHABET[b % TEMPORARY_PASSWORD_ALPHABET.length];
  return out;
}

/** Compara una contraseña con el "salt:hash" guardado (tiempo constante). */
export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  if (!stored) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const computed = (await scryptAsync(password, salt, 64)).toString("hex");
  const a = Buffer.from(computed);
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
