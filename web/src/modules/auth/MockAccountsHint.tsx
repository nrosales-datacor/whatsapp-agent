import { MOCK_ACCOUNTS, MOCK_ADMIN_USERNAME, MOCK_INVITATION_TOKEN, MOCK_PASSWORD, MOCK_TOTP_CODE } from "../../lib/mockApi";

/** Ayuda del modo mock (VITE_MOCK_API=1): cuentas ficticias para recorrer el panel. */
export default function MockAccountsHint() {
  return (
    <details className="mock-hint">
      <summary>Modo demo: cuentas de prueba</summary>
      <p>
        Todas usan la clave <code>{MOCK_PASSWORD}</code>. Los datos son ficticios y viven solo en esta pestaña.
      </p>
      <ul>
        {MOCK_ACCOUNTS.map((a) => (
          <li key={a.email}>
            <code>{a.email}</code> — {a.description}
          </li>
        ))}
      </ul>
      <p>
        Otras rutas: <code>/panel/invite/{MOCK_INVITATION_TOKEN}</code> (invitación),{" "}
        <code>/panel/reset-password?token=cualquiera</code> y <code>/panel/admin</code> (usuario{" "}
        <code>{MOCK_ADMIN_USERNAME}</code>, código <code>{MOCK_TOTP_CODE}</code>).
      </p>
    </details>
  );
}
