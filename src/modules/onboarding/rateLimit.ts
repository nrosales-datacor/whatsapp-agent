// ─────────────────────────────────────────────────────────────────────────────
// Rate limit del alta self-service, en memoria (como el del login, sin dependencias): una
// ventana deslizante por clave. Se cuentan los INTENTOS (no solo los fallidos): crear
// negocios o mandar correos de verificación en masa es justamente lo que se quiere frenar.
//
//   • por IP: frena a un script que crea cuentas o bombardea con correos desde un lugar
//     (la IP sale de `getClientIp`, que solo cree X-Forwarded-For detrás de TRUST_PROXY);
//   • por correo: frena el bombardeo de correos a UNA persona desde muchas IPs. La clave es
//     el correo tal como llegó normalizado, exista o no la cuenta: el 429 no revela nada.
//
// Con varias réplicas web cada una cuenta lo suyo (el tope efectivo se multiplica): para
// el volumen de altas esperado alcanza, igual que el rate limit del login.
// ─────────────────────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Topes por hora (se leen en cada intento: los tests los cambian sin reiniciar). */
export function signupLimits() {
  return {
    windowMs: HOUR_MS,
    signupPerIp: intFromEnv("SIGNUP_RATE_LIMIT_PER_IP", 5),
    signupPerEmail: intFromEnv("SIGNUP_RATE_LIMIT_PER_EMAIL", 3),
    resendPerIp: intFromEnv("SIGNUP_RESEND_RATE_LIMIT_PER_IP", 10),
    resendPerEmail: intFromEnv("SIGNUP_RESEND_RATE_LIMIT_PER_EMAIL", 3),
  };
}

export type LimitCheck = { allowed: true } | { allowed: false; retryAfterSec: number };

const hits = new Map<string, number[]>();

/**
 * Cuenta un intento contra `key` si entra en el tope (`limit` por `windowMs`); si no entra,
 * no lo cuenta y dice cuánto esperar.
 */
export function hitLimit(key: string, limit: number, windowMs: number, now: number = Date.now()): LimitCheck {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)) };
  }
  recent.push(now);
  hits.set(key, recent);
  return { allowed: true };
}

// Purga periódica: sin esto el Map crece con cada IP y correo que pasó alguna vez.
const purgeTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, list] of hits) {
    const recent = list.filter((t) => now - t < HOUR_MS);
    if (recent.length === 0) hits.delete(key);
    else hits.set(key, recent);
  }
}, 10 * 60 * 1000);
purgeTimer.unref();

/** Solo para tests: el estado es del módulo y persiste entre tests del mismo proceso. */
export function _resetSignupLimitsForTests(): void {
  hits.clear();
}
