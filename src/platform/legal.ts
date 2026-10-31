// ─────────────────────────────────────────────────────────────────────────────
// Versión de los documentos legales (Carril P, "privacidad y términos"). UNA sola
// constante para los tres documentos de landing/ (términos, privacidad y contrato): cada
// uno la muestra en su cabecera (`data-legal-version`, lo verifica
// test/unit/legalDocuments.test.ts) y el alta, las invitaciones y la reaceptación del
// panel guardan la que estaba vigente al aceptar (tabla `legal_acceptances` del módulo team).
//
// Formato `AAAA-MM-DD` (la fecha del texto): se compara como texto, así que "más nueva" es
// "mayor". Cambiar un texto de forma importante = subir esta fecha en el MISMO cambio que
// el HTML; a la próxima entrada, cada persona cuya aceptación quedó vieja ve en el panel el
// aviso para aceptar de nuevo (`POST /api/panel/auth/legal/accept`, auditado).
// ─────────────────────────────────────────────────────────────────────────────

/** Versión vigente de términos, privacidad y contrato. */
export const LEGAL_VERSION = "2026-10-31";

/** Formato válido de una versión legal. */
export const LEGAL_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** URLs públicas de los documentos (las sirve src/platform/http/landing.ts). */
export const LEGAL_PATHS = { terms: "/terminos", privacy: "/privacidad", contract: "/contrato" } as const;

/** Las versiones que se registran al aceptar (hoy las dos son la misma constante). */
export interface LegalVersions {
  termsVersion: string;
  privacyVersion: string;
}

let versionOverride: string | null = null;

/** Versión vigente (la constante, salvo que un test la suba con `_setLegalVersionForTests`). */
export function currentLegalVersion(): string {
  return versionOverride ?? LEGAL_VERSION;
}

/** Versiones vigentes de términos y privacidad. */
export function currentLegalVersions(): LegalVersions {
  const version = currentLegalVersion();
  return { termsVersion: version, privacyVersion: version };
}

/** ¿Lo aceptado quedó viejo? Sin aceptación (null) también cuenta como pendiente. */
export function legalAcceptanceOutdated(accepted: LegalVersions | null, current: LegalVersions = currentLegalVersions()): boolean {
  if (!accepted) return true;
  return accepted.termsVersion < current.termsVersion || accepted.privacyVersion < current.privacyVersion;
}

/** Solo tests: simula subir `LEGAL_VERSION` (null vuelve a la constante). */
export function _setLegalVersionForTests(version: string | null): void {
  if (version !== null && !LEGAL_VERSION_PATTERN.test(version)) throw new Error("Versión legal inválida (AAAA-MM-DD).");
  versionOverride = version;
}
