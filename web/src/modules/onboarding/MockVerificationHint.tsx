import { Link } from "react-router-dom";
import { mockLastVerificationToken } from "./signupMock";

/** Modo demo (VITE_MOCK_API=1): no hay correo de verdad, así que el enlace se muestra acá. */
export default function MockVerificationHint() {
  const token = mockLastVerificationToken();
  if (!token) return null;
  return (
    <div className="mock-hint">
      <p>
        <strong>Modo demo:</strong> no mandamos correos. Este es el enlace que llegaría:{" "}
        <Link to={`/verify-email?token=${encodeURIComponent(token)}`}>Confirmar mi correo</Link>
      </p>
    </div>
  );
}
