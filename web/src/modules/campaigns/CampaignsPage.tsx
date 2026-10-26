import { Link, useNavigate } from "react-router-dom";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import Icon from "../../ui/Icons";
import PageHeader from "../../ui/PageHeader";
import { STATUS_LABELS as CLIENT_STATUS_LABELS } from "../clients/crmApi";
import { formatDateTime } from "../settings/zonedTime";
import { segmentSummary, STATUS_LABELS, useCampaigns, useCampaignsOverview, type CampaignStatus, type CampaignSummary, type CampaignsOverview } from "./campaignsApi";
import "../settings/settings.css";
import "./campaigns.css";

// ─────────────────────────────────────────────────────────────────────────────
// Campañas (/campaigns, I6.1; dueño y admin, módulo "campaigns"): promociones por WhatsApp a
// un segmento de clientes que aceptaron recibirlas. Lista con el estado y los envíos; el
// encabezado avisa si no hay número o plantilla de marketing para mandarlas.
//   /campaigns/new       borrador nuevo     /campaigns/:id       detalle y resultados
//   /campaigns/:id/edit  editar el borrador
// ─────────────────────────────────────────────────────────────────────────────

export function StatusChip({ status }: { status: CampaignStatus }) {
  return <span className={`cp-status cp-status-${status}`}>{STATUS_LABELS[status]}</span>;
}

/** Aviso de por qué no se pueden mandar campañas todavía (sin número o sin plantilla). */
export function ChannelNotice({ channels }: { channels: CampaignsOverview["channels"] }) {
  if (channels.withTemplate > 0) return null;
  return (
    <div className="cp-notice" role="note">
      <Icon id="alert" size={16} />
      <span>
        {channels.connected === 0 ? (
          <>Para mandar campañas, primero conectá un número en WhatsApp IA.</>
        ) : (
          <>
            Falta la plantilla de marketing aprobada por Meta: cargala en <Link to="/whatsapp/settings">WhatsApp IA › Configuración › Números</Link>. Las
            promociones solo se pueden mandar con plantilla.
          </>
        )}
      </span>
    </div>
  );
}

function when(c: CampaignSummary, tz: string): string {
  if (c.status === "scheduled" && c.scheduledFor) return `Programada para el ${formatDateTime(c.scheduledFor, tz)}`;
  if (c.status === "completed" && c.completedAt) return `Enviada el ${formatDateTime(c.completedAt, tz)}`;
  if (c.status === "sending" && c.startedAt) return `Enviando desde el ${formatDateTime(c.startedAt, tz)}`;
  if (c.status === "cancelled" && c.completedAt) return `Cancelada el ${formatDateTime(c.completedAt, tz)}`;
  return `Creada el ${formatDateTime(c.createdAt, tz)}`;
}

export default function CampaignsPage() {
  const me = useSession();
  const t = terminologyOf(me);
  const navigate = useNavigate();
  const list = useCampaigns();
  const overview = useCampaignsOverview();
  const tz = me.business.timezone;

  return (
    <div className="page">
      <PageHeader title="Campañas" subtitle={`Promociones por WhatsApp para que tus ${t.clients} vuelvan.`}>
        <button type="button" className="btn btn-primary" onClick={() => navigate("/campaigns/new")}>
          <Icon id="plus" size={16} />
          Nueva campaña
        </button>
      </PageHeader>

      {overview.data && (
        <>
          <p className="cp-overview" aria-label="Promociones en tu cartera">
            <span>
              <strong>{overview.data.consent.consented}</strong> de {overview.data.consent.clients} {t.clients} aceptaron recibir promociones
            </span>
            <span>
              <strong>{overview.data.consent.optedOut}</strong> pidieron la baja
            </span>
          </p>
          <ChannelNotice channels={overview.data.channels} />
        </>
      )}

      {list.isPending ? (
        <div className="clients-loading" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>Cargando las campañas…</span>
        </div>
      ) : list.isError ? (
        <ErrorState message={errorMessage(list.error, "No pudimos cargar las campañas.")} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <EmptyState
          icon="megaphone"
          title="Todavía no hay campañas"
          help={`Armá un mensaje, elegí a qué ${t.clients} les llega (por estado, etiquetas o última visita) y mandalo ya o programalo. Solo les llega a quienes aceptaron promociones.`}
          action={{ label: "Nueva campaña", onClick: () => navigate("/campaigns/new"), icon: "plus" }}
        />
      ) : (
        <ul className="cp-list" aria-label="Campañas">
          {list.data.map((c) => (
            <li key={c.id}>
              <Link to={`/campaigns/${c.id}`} className="cp-item">
                <span className="cp-item-main">
                  <span className="cp-item-name">{c.name}</span>
                  <span className="cp-item-meta">
                    {when(c, tz)} · {segmentSummary(c.segment, { status: (s) => CLIENT_STATUS_LABELS[s] })}
                  </span>
                </span>
                {c.status !== "draft" && (
                  <span className="cp-item-counts tnum">
                    {c.counts.sent} de {c.totalRecipients} enviadas
                  </span>
                )}
                <StatusChip status={c.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="settings-help">{capitalize(t.clients)} que respondan «BAJA» dejan de recibir promociones al instante.</p>
    </div>
  );
}
