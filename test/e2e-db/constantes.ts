import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes compartidas entre el servidor E2E CON BASE DE DATOS (servidor.ts) y sus
// specs. SIN efectos secundarios: solo datos. Es la contraparte de
// test/e2e-panel/constantes.ts (que corre en memoria): acá el server tiene un
// Postgres efímero (PGlite), así que se pueden ejercer usuarios, "Mi negocio",
// campañas, el superadmin y todo lo que en memoria responde 503.
// ─────────────────────────────────────────────────────────────────────────────

export const E2E_DB = {
  puerto: Number(process.env.E2E_DB_PORT ?? 3198),
  /** Servidor de control del mock de red (Graph/OpenAI): lo que "envió" el bot, forzar fallas. */
  puertoControl: Number(process.env.E2E_DB_CONTROL_PORT ?? 3197),
  get baseURL() {
    return `http://localhost:${this.puerto}`;
  },
  get controlURL() {
    return `http://localhost:${this.puertoControl}`;
  },
  secret: "e2e-db-session-secret-0123456789abcdef",
  /** 32 bytes en hex: el server cifra los access tokens de cada negocio con esto. */
  tokensKey: "a1".repeat(32),
  appSecret: "e2e-db-app-secret",
  verifyToken: "e2e-db-verify-token",
  superadmin: { usuario: "superadmin", password: "Superadmin-e2e-123" },
  /** Secreto TOTP (base32) del superadmin: el 2FA queda ACTIVO en esta suite. */
  totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
  contactoWhatsapp: "50600000000",
};

export type Rol = "dueno" | "operador";

export interface UsuarioE2E {
  usuario: string;
  password: string;
  rol: Rol;
  tenantId: string;
}

/** Negocios sembrados. Cada uno cubre un estado distinto del panel. */
export const TENANTS = {
  /** Plan Pro con datos de demo (bandeja, agenda, métricas): el principal. */
  clinica: { id: "clinica", nombre: "Clínica Dental Aurora", pnid: "1000000001" },
  /** Plan Básico al 85% de su cuota: aviso amarillo cerrable + pestañas 🔒. */
  basico: { id: "basico", nombre: "Barbería Básica", pnid: "1000000002" },
  /** Plan Básico al 100% de su cuota: aviso rojo NO cerrable. */
  lleno: { id: "lleno", nombre: "Lavacar Lleno", pnid: "1000000003" },
  /** Plan Básico con el tope de gasto de IA agotado. */
  gastoia: { id: "gastoia", nombre: "Taller Gasto IA", pnid: "1000000004" },
  /** Negocio pausado por la plataforma (falta de pago). */
  pausado: { id: "pausado", nombre: "Spa Pausado", pnid: "1000000005" },
} as const;

export const USUARIOS = {
  clinica: { usuario: "clinica", password: "Clinica-e2e-123", rol: "dueno", tenantId: "clinica" },
  clinicaOp: { usuario: "clinica-op", password: "Operador-e2e-123", rol: "operador", tenantId: "clinica" },
  /** Cuenta que el superadmin resetea en el E2E (clave temporal → cambio obligatorio). */
  clinicaReset: { usuario: "clinica-reset", password: "Reset-e2e-1234", rol: "operador", tenantId: "clinica" },
  basico: { usuario: "basico", password: "Basico-e2e-123", rol: "dueno", tenantId: "basico" },
  lleno: { usuario: "lleno", password: "Lleno-e2e-1234", rol: "dueno", tenantId: "lleno" },
  llenoOp: { usuario: "lleno-op", password: "LlenoOp-e2e-123", rol: "operador", tenantId: "lleno" },
  gastoia: { usuario: "gastoia", password: "GastoIa-e2e-123", rol: "dueno", tenantId: "gastoia" },
  pausado: { usuario: "pausado", password: "Pausado-e2e-123", rol: "dueno", tenantId: "pausado" },
} satisfies Record<string, UsuarioE2E>;

/** Cliente del webhook simulado: cada spec usa números propios para no pisarse. */
export function firmarWebhook(cuerpo: string): string {
  return "sha256=" + crypto.createHmac("sha256", E2E_DB.appSecret).update(cuerpo).digest("hex");
}
