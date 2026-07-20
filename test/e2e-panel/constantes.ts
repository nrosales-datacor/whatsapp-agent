// Constantes compartidas entre el servidor E2E (servidor.ts) y las specs de Playwright.
// SIN efectos secundarios: solo datos. El servidor E2E las traduce a variables de
// entorno; las specs las usan para loguearse y para firmar cookies de sesión.

export const E2E = {
  puerto: Number(process.env.E2E_PORT ?? 3199),
  get baseURL() {
    return `http://localhost:${this.puerto}`;
  },
  // Login del tenant fallback (selyon). El servidor E2E computa el hash de este
  // password y lo pone en PANEL_PASSWORD_HASH_SELYON para que el login funcione en
  // modo memoria (sin base de datos).
  usuario: "selyon",
  password: "e2e-password-123",
  tenantId: "selyon",
  // Secreto de firma de sesiones: conocido, para que las specs puedan MINTEAR cookies
  // de operador/dueño y probar los guards de rol sin depender de que exista ese usuario
  // en la base (que en modo memoria no hay).
  secret: "e2e-panel-session-secret-0123456789abcdef",
};
