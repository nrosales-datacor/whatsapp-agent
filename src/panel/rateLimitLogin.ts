import type { IncomingMessage } from "node:http";

// ─────────────────────────────────────────────────────────────────────────────
// Rate limit de login (E6 / BLOQUEANTE-10), en memoria, sin dependencias nuevas.
//
// Dos capas independientes, porque cada una cubre un ataque que la otra no cubre:
//
//   • Por IP: frena a un atacante anónimo (sin ninguna credencial válida) que satura
//     el event loop mandando POSTs al login. Es la defensa directa contra el DoS de
//     BLOQUEANTE-10 (Node es de un solo hilo y este proceso también atiende el
//     webhook de WhatsApp de TODOS los tenants).
//   • Por usuario: frena el fuerza-bruta dirigido a UNA cuenta puntual aunque venga
//     repartido entre varias IPs (proxy corporativo, red móvil con IP compartida,
//     botnet). Es lockout PROGRESIVO, no un baneo permanente — un dueño real que se
//     equivoca de clave un par de veces no debe quedar afuera para siempre.
//
// ── El chequeo va ANTES de correr scrypt ──
// verificarPassword corre scrypt SIEMPRE, incluso cuando el usuario no existe
// (HASH_DUMMY en auth.ts), para no filtrar por timing qué cuentas son válidas. Si
// el rate limit se chequeara DESPUÉS de scrypt, ya habríamos pagado el costo de CPU
// que queremos evitar — por eso `chequearLimiteLogin` se llama ANTES de tocar
// verificarPassword.
//
// ── Por qué la clave "por usuario" es el string crudo, exista o no la cuenta ──
// Si el mapa de lockout SOLO tuviera entradas para usuarios que existen de verdad,
// el 429 mismo se convertiría en un oráculo: "usuario real" -> eventualmente 429;
// "usuario inventado" -> nunca 429 (porque nunca se crea la entrada). Eso filtra
// exactamente lo que HASH_DUMMY existe para ocultar. La solución: la clave del mapa
// es el string TAL CUAL lo mandó el cliente (mismo valor que usa obtenerUsuario en
// el router, sin normalizar casing — normalizarlo agruparía cuentas legítimas
// distintas que solo difieren en mayúsculas). Así "existe pero falló mucho" e
// "inventado" producen el mismo patrón de 429, indistinguible desde afuera.
// ─────────────────────────────────────────────────────────────────────────────

const IP_MAX_INTENTOS = Number(process.env.PANEL_LOGIN_RATE_LIMIT_MAX_IP ?? 10);
const IP_VENTANA_MS = Number(process.env.PANEL_LOGIN_RATE_LIMIT_VENTANA_MS ?? 5 * 60 * 1000); // 5 min

// Lockout progresivo por usuario: arranca a partir del UMBRAL-ésimo fallo consecutivo
// y duplica la espera en cada fallo siguiente, con un tope. Ej. con los defaults:
// fallo 5 -> 30s, fallo 6 -> 1min, fallo 7 -> 2min, ... hasta el tope de 15 min.
const USUARIO_UMBRAL_FALLOS = Number(process.env.PANEL_LOGIN_LOCKOUT_UMBRAL ?? 5);
const USUARIO_BASE_MS = Number(process.env.PANEL_LOGIN_LOCKOUT_BASE_MS ?? 30_000);
const USUARIO_TOPE_MS = Number(process.env.PANEL_LOGIN_LOCKOUT_TOPE_MS ?? 15 * 60 * 1000);

const PURGA_INTERVALO_MS = 10 * 60 * 1000;

interface IntentosIp {
  timestamps: number[]; // ventana deslizante: momentos (epoch ms) de intentos recientes
}
interface IntentosUsuario {
  fallosConsecutivos: number;
  bloqueadoHasta: number; // epoch ms; 0 (o vencido) = sin bloqueo activo
  ultimaActividad: number; // solo para la purga periódica
}

const porIp = new Map<string, IntentosIp>();
const porUsuario = new Map<string, IntentosUsuario>();

export type ResultadoLimite = { permitido: true } | { permitido: false; retryAfterSeg: number };

/**
 * IP del cliente para el límite por IP. Toma la primera de `x-forwarded-for` si existe
 * (deploy típico detrás de un proxy/PM2), si no cae al socket. No es a prueba de
 * spoofing (un atacante puede mentir su propia IP en el header si no hay proxy de
 * confianza en el medio), pero el objetivo es frenar volumen fácil, no autenticar la
 * IP — la capa por usuario cubre el caso de IP falseada/rotada.
 */
export function ipDelRequest(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const primera = Array.isArray(xff) ? xff[0] : xff?.split(",")[0];
  return (primera ?? req.socket.remoteAddress ?? "desconocida").trim();
}

function claveUsuario(ambito: string, usuario: string): string {
  // `ambito` separa el namespace de "login" (usuarios de negocio) del de "admin"
  // (superadmin): evita que un usuario de negocio y el string del superadmin
  // compartan lockout por coincidencia de nombre.
  return `${ambito}:${usuario}`;
}

/**
 * Chequea el límite por IP y por usuario. Se llama ANTES de invocar verificarPassword
 * (ver comentario de cabecera): si ya sabemos que la request se va a rechazar, no gastamos
 * los ~50-150ms de CPU de scrypt en ella.
 */
export function chequearLimiteLogin(ip: string, ambito: string, usuario: string): ResultadoLimite {
  const ahora = Date.now();

  const ipInfo = porIp.get(ip);
  if (ipInfo) {
    ipInfo.timestamps = ipInfo.timestamps.filter((t) => ahora - t < IP_VENTANA_MS);
    if (ipInfo.timestamps.length >= IP_MAX_INTENTOS) {
      const masViejo = ipInfo.timestamps[0];
      return { permitido: false, retryAfterSeg: Math.max(1, Math.ceil((masViejo + IP_VENTANA_MS - ahora) / 1000)) };
    }
  }

  const uInfo = porUsuario.get(claveUsuario(ambito, usuario));
  if (uInfo && uInfo.bloqueadoHasta > ahora) {
    return { permitido: false, retryAfterSeg: Math.max(1, Math.ceil((uInfo.bloqueadoHasta - ahora) / 1000)) };
  }

  return { permitido: true };
}

/** Cuenta un intento contra el límite por IP. Se llama SOLO cuando el request pasó
 *  `chequearLimiteLogin` y va a correr scrypt de verdad (haya o no credenciales válidas):
 *  lo que se limita es el volumen de CPU que esa IP le puede hacer gastar al proceso. */
export function registrarIntentoLogin(ip: string): void {
  const info = porIp.get(ip) ?? { timestamps: [] };
  info.timestamps.push(Date.now());
  porIp.set(ip, info);
}

/** Login fallido (clave incorrecta o usuario inexistente): suma un fallo consecutivo a
 *  ESE string de usuario (exista o no la cuenta — ver comentario de cabecera) y arma o
 *  extiende el lockout progresivo una vez superado el umbral. */
export function registrarFalloLogin(ambito: string, usuario: string): void {
  const ahora = Date.now();
  const clave = claveUsuario(ambito, usuario);
  const info = porUsuario.get(clave) ?? { fallosConsecutivos: 0, bloqueadoHasta: 0, ultimaActividad: ahora };
  info.fallosConsecutivos += 1;
  info.ultimaActividad = ahora;
  if (info.fallosConsecutivos >= USUARIO_UMBRAL_FALLOS) {
    const exceso = info.fallosConsecutivos - USUARIO_UMBRAL_FALLOS;
    info.bloqueadoHasta = ahora + Math.min(USUARIO_BASE_MS * 2 ** exceso, USUARIO_TOPE_MS);
  }
  porUsuario.set(clave, info);
}

/** Login correcto: se perdonan los fallos previos de ESE usuario. No tiene sentido
 *  seguir contando fallos viejos contra una cuenta que recién demostró tener la clave. */
export function registrarExitoLogin(ambito: string, usuario: string): void {
  porUsuario.delete(claveUsuario(ambito, usuario));
}

// Purga periódica de entradas vencidas: sin esto los Maps crecen sin límite con IPs y
// usuarios de intentos pasados (memory leak de un proceso de vida larga bajo PM2).
// unref() para que el temporizador no mantenga vivo el proceso (tests, scripts cortos).
const temporizadorPurga = setInterval(() => {
  const ahora = Date.now();
  for (const [ip, info] of porIp) {
    info.timestamps = info.timestamps.filter((t) => ahora - t < IP_VENTANA_MS);
    if (info.timestamps.length === 0) porIp.delete(ip);
  }
  for (const [clave, info] of porUsuario) {
    const sinBloqueoActivo = info.bloqueadoHasta <= ahora;
    const inactivoHaceRato = ahora - info.ultimaActividad > USUARIO_TOPE_MS;
    if (sinBloqueoActivo && inactivoHaceRato) porUsuario.delete(clave);
  }
}, PURGA_INTERVALO_MS);
temporizadorPurga.unref();

/** Solo para tests: los Maps son estado de módulo (persiste entre tests del mismo
 *  proceso `tsx --test`), así que cada test que dependa del límite necesita arrancar
 *  desde cero en vez de heredar el estado que dejó el test anterior. */
export function _resetParaTests(): void {
  porIp.clear();
  porUsuario.clear();
}
