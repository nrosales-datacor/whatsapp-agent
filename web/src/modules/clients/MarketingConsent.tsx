import { useState } from "react";
import { terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import Dialog from "../../ui/Dialog";
import { FormError } from "../../ui/Field";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { canEditClients } from "./ClientsPage";
import { useMarketingConsent, type ClientDetail } from "./clientsApi";
import { formatDay } from "./format";

// ─────────────────────────────────────────────────────────────────────────────
// Promociones en la ficha (I6, con el módulo Campañas): si el cliente aceptó recibirlas,
// pidió la baja o todavía no dijo nada. Las campañas solo le llegan a quien aceptó. El
// equipo (dueño, admin, recepción) puede registrar lo que el cliente dijo en persona:
// queda en el rastro de auditoría. Retirarlo es una baja (vale igual que "BAJA" por WhatsApp).
// ─────────────────────────────────────────────────────────────────────────────

type Action = "grant" | "revoke";

export default function MarketingConsent({ client }: { client: ClientDetail }) {
  const me = useSession();
  const t = terminologyOf(me);
  const { showToast } = useToast();
  const mutation = useMarketingConsent(me.business.id, client.id);
  const [confirming, setConfirming] = useState<Action | null>(null);
  const canEdit = canEditClients(me.role);
  const consented = Boolean(client.marketingConsentAt) && !client.marketingOptOutAt;
  const tz = me.business.timezone;

  const status = consented
    ? { text: `Acepta promociones desde el ${formatDay(client.marketingConsentAt as string, tz)}.`, icon: "check" as const, className: "client-consent-yes" }
    : client.marketingOptOutAt
      ? { text: `Pidió la baja de promociones el ${formatDay(client.marketingOptOutAt, tz)}.`, icon: "bellOff" as const, className: "client-consent-no" }
      : { text: "Sin respuesta: todavía no aceptó recibir promociones.", icon: "bell" as const, className: "client-consent-none" };

  function close() {
    setConfirming(null);
    mutation.reset();
  }

  function confirm() {
    if (!confirming) return;
    mutation.mutate(confirming === "grant", {
      onSuccess: () => {
        showToast(confirming === "grant" ? "Registramos que acepta recibir promociones." : "Registramos la baja de promociones.");
        close();
      },
    });
  }

  return (
    <section className="card client-section client-consent" aria-labelledby="client-consent-title">
      <h2 id="client-consent-title" className="card-title">
        Promociones
      </h2>
      <p className={`client-consent-status ${status.className}`}>
        <Icon id={status.icon} size={16} />
        <span>{status.text}</span>
      </p>
      <p className="settings-help">
        Las campañas solo le llegan a quien aceptó. Por WhatsApp se le pregunta solo después de su primera {t.appointment}; si te lo dice en persona, registralo
        acá. Los recordatorios de sus {t.appointments} le llegan igual.
      </p>
      {canEdit && (
        <div className="client-consent-actions">
          {!consented && (
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setConfirming("grant")}>
              Registrar que acepta
            </button>
          )}
          {!client.marketingOptOutAt && (
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setConfirming("revoke")}>
              Registrar baja
            </button>
          )}
        </div>
      )}

      <Dialog open={confirming !== null} onClose={close} title={confirming === "grant" ? "¿Acepta recibir promociones?" : "¿Registrar la baja de promociones?"}>
        <p>
          {confirming === "grant"
            ? `Confirmá que ${client.name} te dijo que quiere recibir promociones y novedades por WhatsApp. Queda registrado quién lo cargó y cuándo.`
            : `${client.name} no va a recibir más promociones (sí sus recordatorios). Queda registrado quién lo cargó y cuándo.`}
        </p>
        <FormError message={mutation.isError ? errorMessage(mutation.error, "No pudimos guardar el cambio.") : null} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={close} disabled={mutation.isPending}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" onClick={confirm} disabled={mutation.isPending}>
            {mutation.isPending ? "Guardando…" : confirming === "grant" ? "Sí, acepta" : "Registrar baja"}
          </button>
        </div>
      </Dialog>
    </section>
  );
}
