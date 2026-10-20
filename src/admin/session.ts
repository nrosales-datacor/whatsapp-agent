import crypto from "node:crypto";
import type { ServerResponse } from "node:http";
import { checkLoginLimit, recordLoginAttempt, recordLoginFailure, recordLoginSuccess } from "../platform/auth/loginRateLimit";
import { DUMMY_HASH, verifyPassword } from "../platform/auth/password";
import {
  adminSessionSeconds,
  createAdminSession,
  isAdminTotpConfigured,
  originFingerprint,
  verifyAdminSession,
} from "../platform/auth/sessionToken";
import { consumeTotp } from "../platform/auth/totp";
import { recordAudit, superadminActor } from "../platform/audit/auditLog";
import type { Executor } from "../platform/db/scope";
import { HttpError, tooManyAttempts } from "../platform/http/errors";
import { ADMIN_SESSION_COOKIE, parseCookies, sessionCookie } from "../platform/http/http";
import type { SuperadminResolver } from "../platform/http/routeTypes";

// ─────────────────────────────────────────────────────────────────────────────
// Superadmin (la plataforma): UNA cuenta definida por env, fuera de la base y de todo
// negocio — PANEL_SUPERADMIN_USERNAME + PANEL_SUPERADMIN_HASH (scrypt, ver
// scripts/hashPassword.ts) y, muy recomendado, PANEL_SUPERADMIN_TOTP_SECRET
// (scripts/generateTotp.ts), que vuelve obligatorio el código.
//
// Mismo endurecimiento que el login del equipo (rate limit antes de scrypt, scrypt
// siempre, 401 genérico) más: sesión corta en su propia cookie `panel_admin_session`
// (SameSite=Strict) y rastro en audit_log de cada login, y de cada código rechazado con
// la clave correcta (señal de que la clave se filtró). La IP nunca va en claro al rastro:
// solo una huella no reversible.
// ─────────────────────────────────────────────────────────────────────────────

const RATE_SCOPE = "admin";

/** Usuario del superadmin configurado (null = no hay superadmin: nadie entra). */
export function superadminUsername(): string | null {
  return process.env.PANEL_SUPERADMIN_USERNAME?.trim() || null;
}

function sameText(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** El `SuperadminResolver` del router: cookie de admin firmada y vigente (y con 2FA si está configurado). */
export const resolveSuperadmin: SuperadminResolver = async (req) => {
  const username = superadminUsername();
  if (!username) return null;
  return verifyAdminSession(parseCookies(req)[ADMIN_SESSION_COOKIE]) ? { adminId: username } : null;
};

export type AdminLoginResult = { status: "totp_required" } | { status: "ok"; withTotp: boolean };

const invalidCredentials = () => new HttpError(401, "Usuario, clave o código incorrectos.", "invalid_credentials");

export async function adminLogin(
  db: Executor,
  input: { username: string; password: string; totpCode?: string; ip: string },
): Promise<AdminLoginResult> {
  const { username, ip } = input;
  const limit = checkLoginLimit(ip, RATE_SCOPE, username);
  if (!limit.allowed) throw tooManyAttempts(limit.retryAfterSec);
  recordLoginAttempt(ip);

  const expected = superadminUsername();
  const usernameOk = expected !== null && sameText(username, expected);
  // scrypt SIEMPRE (DUMMY_HASH si falta la config): no filtra por timing si el usuario es el correcto.
  const passwordOk = await verifyPassword(input.password, process.env.PANEL_SUPERADMIN_HASH?.trim() || DUMMY_HASH);
  if (!usernameOk || !passwordOk || !expected) {
    recordLoginFailure(ip, RATE_SCOPE, username);
    throw invalidCredentials();
  }

  let withTotp = false;
  if (isAdminTotpConfigured()) {
    const code = input.totpCode?.trim();
    if (!code) return { status: "totp_required" };
    const result = consumeTotp(process.env.PANEL_SUPERADMIN_TOTP_SECRET ?? "", code);
    if (result !== "ok") {
      recordLoginFailure(ip, RATE_SCOPE, username);
      await recordAudit(db, null, "admin_login_rejected", superadminActor(expected), {
        reason: result === "reused" ? "code_reused" : "code_invalid",
        origin: originFingerprint(ip),
      });
      throw invalidCredentials();
    }
    withTotp = true;
  }

  recordLoginSuccess(ip, RATE_SCOPE, username);
  await recordAudit(db, null, "admin_login", superadminActor(expected), { totp: withTotp, origin: originFingerprint(ip) });
  return { status: "ok", withTotp };
}

export function setAdminSessionCookie(res: ServerResponse, withTotp: boolean): void {
  res.setHeader(
    "set-cookie",
    sessionCookie(ADMIN_SESSION_COOKIE, createAdminSession(withTotp), { maxAgeSec: adminSessionSeconds(), sameSite: "Strict" }),
  );
}

export function clearAdminSessionCookie(res: ServerResponse): void {
  res.setHeader("set-cookie", sessionCookie(ADMIN_SESSION_COOKIE, "", { maxAgeSec: 0, sameSite: "Strict" }));
}
