import {
  MOCK_ACCOUNTS,
  MOCK_ADMIN_USERNAME,
  MOCK_EXISTING_INVITATION_TOKEN,
  MOCK_INVITATION_TOKEN,
  MOCK_PASSWORD,
  MOCK_TOTP_CODE,
} from "../../lib/mockApi";

/** Ayuda del modo mock (VITE_MOCK_API=1): cuentas ficticias para recorrer el panel. */
export default function MockAccountsHint() {
  return (
    <details className="mock-hint">
      <summary>Modo demo: cuentas de prueba</summary>
      <p>
        Todas usan la clave <code>{MOCK_PASSWORD}</code> y el código de 2FA <code>{MOCK_TOTP_CODE}</code>. Los datos son
        ficticios y viven solo en esta pestaña.
      </p>
      <ul>
        {MOCK_ACCOUNTS.map((a) => (
          <li key={a.email}>
            <code>{a.email}</code> — {a.description}
          </li>
        ))}
      </ul>
      <p>
        Invitaciones: <code>/panel/accept-invitation?token={MOCK_INVITATION_TOKEN}</code> (cuenta nueva) y{" "}
        <code>/panel/accept-invitation?token={MOCK_EXISTING_INVITATION_TOKEN}</code> (cuenta que ya existe, con 2FA).
        Recuperar clave: <code>/panel/reset-password?token=cualquiera</code>. Superadmin: <code>/panel/admin</code>{" "}
        (usuario <code>{MOCK_ADMIN_USERNAME}</code>). Alta self-service: <code>/panel/signup</code> (el enlace para confirmar el
        correo aparece en pantalla).
      </p>
    </details>
  );
}
