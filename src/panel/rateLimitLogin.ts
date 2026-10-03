import type { IncomingMessage } from "node:http";
import { ipDelCliente } from "../red/ipCliente";

// ─────────────────────────────────────────────────────────────────────────────
// Rate limit de login (E6 / BLOQUEANTE-10), en memoria, sin dependencias nuevas.
//
// Tres capas independientes, porque cada una cubre un ataque que las otras no cubren
// (rediseño de la revisión de seguridad pre-venta 2026-10):
//
//   • Por IP: frena a un atacante anónimo (sin ninguna credencial válida) que satura
//     el event loop mandando POSTs al login. Es la defensa directa contra el DoS de
//     BLOQUEANTE-10 (Node es de un solo hilo y este proceso también atiende el
//     webhook de WhatsApp de TODOS los tenants). La IP sale de `ipDelCliente`
//     (src/red/ipCliente.ts): ya NO se cree el `X-Forwarded-For` que manda el cliente
//     salvo que `TRUST_PROXY` diga que hay un proxy de confianza delante — antes un
//     atacante rotaba ese header y se saltaba este límite.
//   • Por par (IP, usuario): lockout PROGRESIVO tras pocos fallos. Antes era por usuario
//     a secas, GLOBAL: 5 fallos desde cualquier lado contra "dueno-x" dejaban afuera al
//     dueño real de ese negocio (y como los usuarios son únicos en todo el sistema, un
//     atacante podía bloquear a cualquier negocio sabiendo su usuario). Ahora el que
//     queda bloqueado es quien falla, desde donde falla.
//   • Por usuario, global, con umbral MUCHO más alto: freno contra la fuerza bruta
//     DISTRIBUIDA (muchas IPs contra una misma cuenta, cada una por debajo del umbral
//     por par). Para que tampoco sirva para dejar afuera al dueño, no se le aplica a las
//     IPs desde las que esa cuenta ya entró bien hace poco ("IPs conocidas").
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

// Lockout progresivo por par (IP, usuario): arranca a partir del UMBRAL-ésimo fallo
// consecutivo y duplica la espera en cada fallo siguiente, con un tope. Ej. con los
// defaults: fallo 5 -> 30s, fallo 6 -> 1min, fallo 7 -> 2min, ... hasta 15 min.
const PAR_UMBRAL_FALLOS = Number(process.env.PANEL_LOGIN_LOCKOUT_UMBRAL ?? 5);
const PAR_BASE_MS = Number(process.env.PANEL_LOGIN_LOCKOUT_BASE_MS ?? 30_000);
const TOPE_MS = Number(process.env.PANEL_LOGIN_LOCKOUT_TOPE_MS ?? 15 * 60 * 1000);

// Freno global por usuario (fuerza bruta distribuida): mismo esquema progresivo, con un
// umbral bastante más alto que el del par para que un par de typos (o un atacante solo)
// nunca lo disparen.
const GLOBAL_UMBRAL_FALLOS = Number(process.env.PANEL_LOGIN_LOCKOUT_GLOBAL_UMBRAL ?? 25);
const GLOBAL_BASE_MS = Number(process.env.PANEL_LOGIN_LOCKOUT_GLOBAL_BASE_MS ?? 60_000);

// IPs desde las que la cuenta entró bien: exentas del freno global durante este tiempo.
const IP_CONOCIDA_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días
const MAX_IPS_CONOCIDAS = 10;

const PURGA_INTERVALO_MS = 10 * 60 * 1000;

interface IntentosIp {
  timestamps: number[]; // ventana deslizante: momentos (epoch ms) de intentos recientes
}
interface Lockout {
  fallosConsecutivos: number;
  bloqueadoHasta: number; // epoch ms; 0 (o vencido) = sin bloqueo activo
  ultimaActividad: number; // solo para la purga periódica
}

const porIp = new Map<string, IntentosIp>();
const porPar = new Map<string, Lockout>();
const porUsuarioGlobal = new Map<string, Lockout>();
const ipsConocidas = new Map<string, Map<string, number>>(); // clave usuario → (ip → vence)

export type ResultadoLimite = { permitido: true } | { permitido: false; retryAfterSeg: number };

/** IP del cliente para el límite por IP (ver src/red/ipCliente.ts y `TRUST_PROXY`). */
export function ipDelRequest(req: IncomingMessage): string {
  return ipDelCliente(req);
}

function claveUsuario(ambito: string, usuario: string): string {
  // `ambito` separa el namespace de "login" (usuarios de negocio) del de "admin"
  // (superadmin): evita que un usuario de negocio y el string del superadmin
  // compartan lockout por coincidencia de nombre.
  return `${ambito}:${usuario}`;
}

function clavePar(ip: string, ambito: string, usuario: string): string {
  return `${ip}|${claveUsuario(ambito, usuario)}`;
}

function retry(hasta: number, ahora: number): ResultadoLimite {
  return { permitido: false, retryAfterSeg: Math.max(1, Math.ceil((hasta - ahora) / 1000)) };
}

function esIpConocida(ip: string, cu: string, ahora: number): boolean {
  const vence = ipsConocidas.get(cu)?.get(ip);
  return vence !== undefined && vence > ahora;
}

/**
 * Chequea los tres límites (IP, par IP+usuario y global por usuario). Se llama ANTES de
 * invocar verificarPassword (ver comentario de cabecera): si ya sabemos que la request se
 * va a rechazar, no gastamos los ~50-150ms de CPU de scrypt en ella.
 */
export function chequearLimiteLogin(ip: string, ambito: string, usuario: string): ResultadoLimite {
  const ahora = Date.now();

  const ipInfo = porIp.get(ip);
  if (ipInfo) {
    ipInfo.timestamps = ipInfo.timestamps.filter((t) => ahora - t < IP_VENTANA_MS);
    if (ipInfo.timestamps.length >= IP_MAX_INTENTOS) return retry(ipInfo.timestamps[0] + IP_VENTANA_MS, ahora);
  }

  const par = porPar.get(clavePar(ip, ambito, usuario));
  if (par && par.bloqueadoHasta > ahora) return retry(par.bloqueadoHasta, ahora);

  const cu = claveUsuario(ambito, usuario);
  const global = porUsuarioGlobal.get(cu);
  if (global && global.bloqueadoHasta > ahora && !esIpConocida(ip, cu, ahora)) return retry(global.bloqueadoHasta, ahora);

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

function sumarFallo(mapa: Map<string, Lockout>, clave: string, umbral: number, baseMs: number, ahora: number): void {
  const info = mapa.get(clave) ?? { fallosConsecutivos: 0, bloqueadoHasta: 0, ultimaActividad: ahora };
  info.fallosConsecutivos += 1;
  info.ultimaActividad = ahora;
  if (info.fallosConsecutivos >= umbral) {
    const exceso = info.fallosConsecutivos - umbral;
    info.bloqueadoHasta = ahora + Math.min(baseMs * 2 ** exceso, TOPE_MS);
  }
  mapa.set(clave, info);
}

/** Login fallido (clave/código incorrecto o usuario inexistente): suma un fallo al par
 *  (IP, usuario) y al contador global de ESE string de usuario (exista o no la cuenta —
 *  ver comentario de cabecera), y arma o extiende los lockouts progresivos. */
export function registrarFalloLogin(ip: string, ambito: string, usuario: string): void {
  const ahora = Date.now();
  sumarFallo(porPar, clavePar(ip, ambito, usuario), PAR_UMBRAL_FALLOS, PAR_BASE_MS, ahora);
  sumarFallo(porUsuarioGlobal, claveUsuario(ambito, usuario), GLOBAL_UMBRAL_FALLOS, GLOBAL_BASE_MS, ahora);
}

/** Login correcto: se perdonan los fallos previos de ESE par (IP, usuario) y la IP queda
 *  como "conocida" para esa cuenta (exenta del freno global). El contador global NO se
 *  resetea: si alguien está probando claves desde muchas IPs, que el dueño entre no le
 *  devuelve el presupuesto de intentos al atacante. */
export function registrarExitoLogin(ip: string, ambito: string, usuario: string): void {
  const ahora = Date.now();
  porPar.delete(clavePar(ip, ambito, usuario));
  const cu = claveUsuario(ambito, usuario);
  const conocidas = ipsConocidas.get(cu) ?? new Map<string, number>();
  conocidas.delete(ip); // re-insertar la deja como la más reciente (orden del Map)
  conocidas.set(ip, ahora + IP_CONOCIDA_TTL_MS);
  while (conocidas.size > MAX_IPS_CONOCIDAS) conocidas.delete(conocidas.keys().next().value!);
  ipsConocidas.set(cu, conocidas);
}

// Purga periódica de entradas vencidas: sin esto los Maps crecen sin límite con IPs y
// usuarios de intentos pasados (memory leak de un proceso de vida larga bajo PM2).
// unref() para que el temporizador no mantenga vivo el proceso (tests, scripts cortos).
function purgar(mapa: Map<string, Lockout>, ahora: number): void {
  for (const [clave, info] of mapa) {
    const sinBloqueoActivo = info.bloqueadoHasta <= ahora;
    const inactivoHaceRato = ahora - info.ultimaActividad > TOPE_MS;
    if (sinBloqueoActivo && inactivoHaceRato) mapa.delete(clave);
  }
}
const temporizadorPurga = setInterval(() => {
  const ahora = Date.now();
  for (const [ip, info] of porIp) {
    info.timestamps = info.timestamps.filter((t) => ahora - t < IP_VENTANA_MS);
    if (info.timestamps.length === 0) porIp.delete(ip);
  }
  purgar(porPar, ahora);
  purgar(porUsuarioGlobal, ahora);
  for (const [cu, conocidas] of ipsConocidas) {
    for (const [ip, vence] of conocidas) if (vence <= ahora) conocidas.delete(ip);
    if (conocidas.size === 0) ipsConocidas.delete(cu);
  }
}, PURGA_INTERVALO_MS);
temporizadorPurga.unref();

/** Solo para tests: los Maps son estado de módulo (persiste entre tests del mismo
 *  proceso `tsx --test`), así que cada test que dependa del límite necesita arrancar
 *  desde cero en vez de heredar el estado que dejó el test anterior. */
export function _resetParaTests(): void {
  porIp.clear();
  porPar.clear();
  porUsuarioGlobal.clear();
  ipsConocidas.clear();
}
