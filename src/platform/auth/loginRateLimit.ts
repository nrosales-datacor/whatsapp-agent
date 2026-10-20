// ─────────────────────────────────────────────────────────────────────────────
// Rate limit de login, en memoria, sin dependencias nuevas.
//
// Tres capas independientes, porque cada una cubre un ataque que las otras no cubren:
//
//   • Por IP: frena a un atacante anónimo (sin ninguna credencial válida) que satura el
//     event loop mandando POSTs al login. Node es de un solo hilo y este proceso también
//     atiende la API y los webhooks de TODOS los negocios. La IP sale de `getClientIp`
//     (src/platform/net/clientIp.ts): NO se cree el `X-Forwarded-For` que manda el
//     cliente salvo que `TRUST_PROXY` diga que hay un proxy de confianza delante — si no,
//     un atacante rota ese header y se salta este límite.
//   • Por par (IP, usuario): lockout PROGRESIVO tras pocos fallos. Si fuera por usuario a
//     secas, GLOBAL, 5 fallos desde cualquier lado contra una cuenta dejarían afuera al
//     dueño real (y como los usuarios son únicos en todo el sistema, un atacante podría
//     bloquear a cualquiera sabiendo su usuario). Queda bloqueado quien falla, desde donde
//     falla.
//   • Por usuario, global, con umbral MUCHO más alto: freno contra la fuerza bruta
//     DISTRIBUIDA (muchas IPs contra una misma cuenta, cada una por debajo del umbral por
//     par). Para que tampoco sirva para dejar afuera al dueño, no se aplica a las IPs
//     desde las que esa cuenta ya entró bien hace poco ("IPs conocidas").
//
// ── El chequeo va ANTES de correr scrypt ──
// verifyPassword corre scrypt SIEMPRE, incluso cuando el usuario no existe (DUMMY_HASH en
// ./password.ts), para no filtrar por timing qué cuentas son válidas. Si el rate limit se
// chequeara DESPUÉS de scrypt, ya habríamos pagado el costo de CPU que queremos evitar —
// por eso `checkLoginLimit` se llama ANTES de tocar verifyPassword.
//
// ── Por qué la clave "por usuario" es el string crudo, exista o no la cuenta ──
// Si el mapa de lockout SOLO tuviera entradas para usuarios que existen de verdad, el 429
// mismo se convertiría en un oráculo: "usuario real" → eventualmente 429; "usuario
// inventado" → nunca 429. Eso filtra exactamente lo que DUMMY_HASH existe para ocultar.
// La clave del mapa es el string TAL CUAL lo mandó el cliente (sin normalizar: agruparía
// cuentas distintas). Así "existe pero falló mucho" e "inventado" producen el mismo
// patrón de 429, indistinguible desde afuera.
// ─────────────────────────────────────────────────────────────────────────────

const IP_MAX_ATTEMPTS = Number(process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP ?? 10);
const IP_WINDOW_MS = Number(process.env.PANEL_LOGIN_RATE_LIMIT_WINDOW_MS ?? 5 * 60 * 1000); // 5 min

// Lockout progresivo por par (IP, usuario): arranca a partir del THRESHOLD-ésimo fallo
// consecutivo y duplica la espera en cada fallo siguiente, con un tope. Ej. con los
// defaults: fallo 5 → 30 s, fallo 6 → 1 min, fallo 7 → 2 min, … hasta 15 min.
const PAIR_FAILURE_THRESHOLD = Number(process.env.PANEL_LOGIN_LOCKOUT_THRESHOLD ?? 5);
const PAIR_BASE_MS = Number(process.env.PANEL_LOGIN_LOCKOUT_BASE_MS ?? 30_000);
const MAX_LOCKOUT_MS = Number(process.env.PANEL_LOGIN_LOCKOUT_MAX_MS ?? 15 * 60 * 1000);

// Freno global por usuario (fuerza bruta distribuida): mismo esquema progresivo, con un
// umbral bastante más alto que el del par para que un par de typos (o un atacante solo)
// nunca lo disparen.
const GLOBAL_FAILURE_THRESHOLD = Number(process.env.PANEL_LOGIN_LOCKOUT_GLOBAL_THRESHOLD ?? 25);
const GLOBAL_BASE_MS = Number(process.env.PANEL_LOGIN_LOCKOUT_GLOBAL_BASE_MS ?? 60_000);

// IPs desde las que la cuenta entró bien: exentas del freno global durante este tiempo.
const KNOWN_IP_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días
const MAX_KNOWN_IPS = 10;

const PURGE_INTERVAL_MS = 10 * 60 * 1000;

interface IpAttempts {
  timestamps: number[]; // ventana deslizante: momentos (epoch ms) de intentos recientes
}
interface Lockout {
  consecutiveFailures: number;
  lockedUntil: number; // epoch ms; 0 (o vencido) = sin bloqueo activo
  lastActivity: number; // solo para la purga periódica
}

const byIp = new Map<string, IpAttempts>();
const byPair = new Map<string, Lockout>();
const byUserGlobal = new Map<string, Lockout>();
const knownIps = new Map<string, Map<string, number>>(); // clave usuario → (ip → vence)

export type LimitResult = { allowed: true } | { allowed: false; retryAfterSec: number };

function userKey(scope: string, username: string): string {
  // `scope` separa namespaces (p. ej. "login" del equipo y "admin" del superadmin): evita
  // que un usuario de negocio y el superadmin compartan lockout por coincidencia de nombre.
  return `${scope}:${username}`;
}

function pairKey(ip: string, scope: string, username: string): string {
  return `${ip}|${userKey(scope, username)}`;
}

function retry(until: number, now: number): LimitResult {
  return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((until - now) / 1000)) };
}

function isKnownIp(ip: string, key: string, now: number): boolean {
  const expires = knownIps.get(key)?.get(ip);
  return expires !== undefined && expires > now;
}

/**
 * Chequea los tres límites (IP, par IP+usuario y global por usuario). Se llama ANTES de
 * invocar verifyPassword (ver cabecera): si ya sabemos que la request se va a rechazar,
 * no gastamos los ~50-150 ms de CPU de scrypt en ella.
 */
export function checkLoginLimit(ip: string, scope: string, username: string): LimitResult {
  const now = Date.now();

  const ipInfo = byIp.get(ip);
  if (ipInfo) {
    ipInfo.timestamps = ipInfo.timestamps.filter((t) => now - t < IP_WINDOW_MS);
    if (ipInfo.timestamps.length >= IP_MAX_ATTEMPTS) return retry(ipInfo.timestamps[0] + IP_WINDOW_MS, now);
  }

  const pair = byPair.get(pairKey(ip, scope, username));
  if (pair && pair.lockedUntil > now) return retry(pair.lockedUntil, now);

  const key = userKey(scope, username);
  const global = byUserGlobal.get(key);
  if (global && global.lockedUntil > now && !isKnownIp(ip, key, now)) return retry(global.lockedUntil, now);

  return { allowed: true };
}

/**
 * Cuenta un intento contra el límite por IP. Se llama SOLO cuando el request pasó
 * `checkLoginLimit` y va a correr scrypt de verdad (haya o no credenciales válidas): lo
 * que se limita es el volumen de CPU que esa IP le puede hacer gastar al proceso.
 */
export function recordLoginAttempt(ip: string): void {
  const info = byIp.get(ip) ?? { timestamps: [] };
  info.timestamps.push(Date.now());
  byIp.set(ip, info);
}

function addFailure(map: Map<string, Lockout>, key: string, threshold: number, baseMs: number, now: number): void {
  const info = map.get(key) ?? { consecutiveFailures: 0, lockedUntil: 0, lastActivity: now };
  info.consecutiveFailures += 1;
  info.lastActivity = now;
  if (info.consecutiveFailures >= threshold) {
    const excess = info.consecutiveFailures - threshold;
    info.lockedUntil = now + Math.min(baseMs * 2 ** excess, MAX_LOCKOUT_MS);
  }
  map.set(key, info);
}

/**
 * Login fallido (clave/código incorrecto o usuario inexistente): suma un fallo al par
 * (IP, usuario) y al contador global de ESE string de usuario (exista o no la cuenta —
 * ver cabecera), y arma o extiende los lockouts progresivos.
 */
export function recordLoginFailure(ip: string, scope: string, username: string): void {
  const now = Date.now();
  addFailure(byPair, pairKey(ip, scope, username), PAIR_FAILURE_THRESHOLD, PAIR_BASE_MS, now);
  addFailure(byUserGlobal, userKey(scope, username), GLOBAL_FAILURE_THRESHOLD, GLOBAL_BASE_MS, now);
}

/**
 * Login correcto: se perdonan los fallos previos de ESE par (IP, usuario) y la IP queda
 * como "conocida" para esa cuenta (exenta del freno global). El contador global NO se
 * resetea: si alguien está probando claves desde muchas IPs, que el dueño entre no le
 * devuelve el presupuesto de intentos al atacante.
 */
export function recordLoginSuccess(ip: string, scope: string, username: string): void {
  const now = Date.now();
  byPair.delete(pairKey(ip, scope, username));
  const key = userKey(scope, username);
  const known = knownIps.get(key) ?? new Map<string, number>();
  known.delete(ip); // re-insertar la deja como la más reciente (orden del Map)
  known.set(ip, now + KNOWN_IP_TTL_MS);
  while (known.size > MAX_KNOWN_IPS) known.delete(known.keys().next().value!);
  knownIps.set(key, known);
}

// Purga periódica de entradas vencidas: sin esto los Maps crecen sin límite con IPs y
// usuarios de intentos pasados (memory leak de un proceso de vida larga bajo PM2).
// unref() para que el temporizador no mantenga vivo el proceso (tests, scripts cortos).
function purge(map: Map<string, Lockout>, now: number): void {
  for (const [key, info] of map) {
    const noActiveLock = info.lockedUntil <= now;
    const idleForAWhile = now - info.lastActivity > MAX_LOCKOUT_MS;
    if (noActiveLock && idleForAWhile) map.delete(key);
  }
}
const purgeTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, info] of byIp) {
    info.timestamps = info.timestamps.filter((t) => now - t < IP_WINDOW_MS);
    if (info.timestamps.length === 0) byIp.delete(ip);
  }
  purge(byPair, now);
  purge(byUserGlobal, now);
  for (const [key, known] of knownIps) {
    for (const [ip, expires] of known) if (expires <= now) known.delete(ip);
    if (known.size === 0) knownIps.delete(key);
  }
}, PURGE_INTERVAL_MS);
purgeTimer.unref();

/**
 * Solo para tests: los Maps son estado de módulo (persiste entre tests del mismo proceso
 * `tsx --test`), así que cada test que dependa del límite arranca desde cero.
 */
export function _resetForTests(): void {
  byIp.clear();
  byPair.clear();
  byUserGlobal.clear();
  knownIps.clear();
}
