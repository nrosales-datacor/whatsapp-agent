import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isApiError } from "../../lib/api";
import type { Me, MeLegal } from "../../lib/contract";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { acceptLegal } from "../../modules/auth/authApi";
import { ME_QUERY_KEY, useSession } from "../session";

// ─────────────────────────────────────────────────────────────────────────────
// Aviso de términos y privacidad arriba del contenido (Carril P): aparece cuando
// `me.legal.mustAccept` (la persona nunca aceptó en este negocio, o lo que aceptó es más
// viejo que la versión vigente). No tapa el panel: queda fijo hasta aceptar. El dueño lo
// acepta también en nombre del negocio (por eso ve además el contrato).
//
// Manda la versión que se mostró: si cambió en el medio (409 `legal_version_changed`) se
// recarga `me` y el aviso queda con la versión nueva.
// ─────────────────────────────────────────────────────────────────────────────

export default function LegalBanner() {
  const me = useSession();
  const qc = useQueryClient();
  const { showToast } = useToast();
  const legal = me.legal;
  const mutation = useMutation({
    mutationFn: (version: string) => acceptLegal(version),
    onSuccess: (next: MeLegal) => {
      qc.setQueryData<Me | null>(ME_QUERY_KEY, (old) => (old ? { ...old, legal: next } : old));
      showToast("Listo, quedó registrada tu aceptación.");
    },
    onError: (error) => {
      if (isApiError(error, "legal_version_changed")) void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      showToast(isApiError(error) ? error.message : "No pudimos registrar tu aceptación. Probá de nuevo.");
    },
  });
  if (!legal?.mustAccept) return null;

  const owner = me.role === "owner";
  const message = legal.accepted
    ? `Actualizamos los términos del servicio y el aviso de privacidad (versión ${legal.version}). Revisalos y aceptalos para seguir usando el panel.`
    : "Para seguir usando el panel, revisá y aceptá los términos del servicio y el aviso de privacidad.";

  return (
    <div className="billing-banner billing-banner-warning legal-banner" role="region" aria-label="Términos y privacidad">
      <Icon id="alert" size={16} />
      <span className="billing-banner-text">
        {message} {owner ? "Como dueño, los aceptás también en nombre del negocio." : null}{" "}
        <a href="/terminos" target="_blank" rel="noreferrer" className="billing-banner-link">
          Términos
        </a>{" "}
        ·{" "}
        <a href="/privacidad" target="_blank" rel="noreferrer" className="billing-banner-link">
          Privacidad
        </a>
        {owner && (
          <>
            {" "}
            ·{" "}
            <a href="/contrato" target="_blank" rel="noreferrer" className="billing-banner-link">
              Contrato
            </a>
          </>
        )}
      </span>
      <button type="button" className="btn btn-primary legal-banner-accept" disabled={mutation.isPending} onClick={() => mutation.mutate(legal.version)}>
        {mutation.isPending ? "Guardando…" : "Leí y acepto"}
      </button>
    </div>
  );
}
