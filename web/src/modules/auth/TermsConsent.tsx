// ─────────────────────────────────────────────────────────────────────────────
// Casilla "Acepto los términos y el aviso de privacidad" del alta self-service y de aceptar
// una invitación. El backend la exige (`acceptTerms: true`) y guarda qué versión aceptó la
// persona y cuándo (`legal_acceptances`). Los documentos abren en otra pestaña para no
// perder lo que se escribió en el formulario.
// ─────────────────────────────────────────────────────────────────────────────

/** Mensaje cuando falta la casilla (el mismo que devuelve el backend). */
export const TERMS_REQUIRED_MESSAGE = "Tenés que aceptar los términos y el aviso de privacidad.";

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  error?: string;
}

export default function TermsConsent({ checked, onChange, error }: Props) {
  return (
    <>
      <label className="signup-terms">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-invalid={error ? true : undefined} />
        <span>
          Acepto los{" "}
          <a href="/terminos" target="_blank" rel="noreferrer" className="link">
            términos
          </a>{" "}
          y el{" "}
          <a href="/privacidad" target="_blank" rel="noreferrer" className="link">
            aviso de privacidad
          </a>
          .
        </span>
      </label>
      {error && <p className="field-error">{error}</p>}
    </>
  );
}
