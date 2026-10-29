import Icon from "../../ui/Icons";
import type { ClientStatus } from "./clientsApi";
import { STATUS_HELP, STATUS_LABELS } from "./crmApi";

/** Estado del cliente (CRM del Pro) como etiqueta de color, con su explicación en el título. */
export function StatusBadge({ status }: { status: ClientStatus }) {
  return (
    <span className={`badge client-status client-status-${status}`} title={STATUS_HELP[status]}>
      {STATUS_LABELS[status]}
    </span>
  );
}

/** Estrella de VIP (manual o por reglas) junto al nombre. */
export function VipMark() {
  return (
    <span className="client-vip" title="VIP" aria-label="VIP" role="img">
      <Icon id="star" size={14} strokeWidth={2.2} />
    </span>
  );
}
