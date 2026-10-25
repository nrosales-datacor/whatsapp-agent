import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import Dialog from "../../ui/Dialog";
import ErrorState from "../../ui/ErrorState";
import { FormError, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import PageHeader from "../../ui/PageHeader";
import { useToast } from "../../ui/Toast";
import { STATUS_LABELS as CLIENT_STATUS_LABELS } from "../clients/crmApi";
import { todayIn } from "../scheduling/format";
import { formatDateTime, zonedToIso } from "../settings/zonedTime";
import { campaignKeys, campaignsApi, segmentSummary, SEND_STATUS_LABELS, useCampaign, useCampaignMutation, type CampaignDetail } from "./campaignsApi";
import { StatusChip } from "./CampaignsPage";
import "../settings/settings.css";
import "./campaigns.css";

// ─────────────────────────────────────────────────────────────────────────────
// Detalle de una campaña (/campaigns/:id). En borrador: editar, borrar y lanzar (ya o
// programada, con confirmación). Lanzada: envíos, resultados (cuántos respondieron por
// WhatsApp y cuántas citas se agendaron después) y destinatarios; mientras se manda o
// espera su hora se refresca sola y se puede cancelar lo que falte.
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_REASONS: Record<string, string> = {
  not_reachable: "Ya no acepta promociones",
  cancelled: "Campaña cancelada",
  no_template: "Sin plantilla de marketing",
  no_channel: "Sin número conectado",
  token_invalid: "Acceso de Meta vencido",
  send_failed: "WhatsApp no lo aceptó",
};

export default function CampaignDetailPage() {
  const { id = "" } = useParams();
  const query = useCampaign(id);
  return (
    <div className="page">
      <Link to="/campaigns" className="back-link">
        <Icon id="chevronLeft" size={16} />
        Volver a Campañas
      </Link>
      {query.isPending ? (
        <div className="clients-loading" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>Cargando la campaña…</span>
        </div>
      ) : query.isError ? (
        <ErrorState message={errorMessage(query.error, "No pudimos cargar la campaña.")} onRetry={() => void query.refetch()} />
      ) : (
        <Detail campaign={query.data} />
      )}
    </div>
  );
}

function Detail({ campaign }: { campaign: CampaignDetail }) {
  const me = useSession();
  const t = terminologyOf(me);
  const tz = me.business.timezone;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [launching, setLaunching] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "cancel" | null>(null);
  const cancel = useCampaignMutation(() => campaignsApi.cancel(campaign.id));
  const remove = useMutation({
    mutationFn: () => campaignsApi.remove(campaign.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: campaignKeys.list });
      showToast("Borramos el borrador.");
      navigate("/campaigns");
    },
  });
  const draft = campaign.status === "draft";
  const live = campaign.status === "scheduled" || campaign.status === "sending";
  const c = campaign.counts;

  return (
    <>
      <PageHeader title={campaign.name} tabTitle={`${campaign.name} · Campañas`}>
        <StatusChip status={campaign.status} />
        {draft && (
          <>
            <Link to={`/campaigns/${campaign.id}/edit`} className="btn btn-secondary">
              <Icon id="pencil" size={16} />
              Editar
            </Link>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirm("delete")}>
              <Icon id="trash" size={16} />
              Borrar
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setLaunching(true)}>
              <Icon id="send" size={16} />
              Lanzar
            </button>
          </>
        )}
        {live && (
          <button type="button" className="btn btn-secondary" onClick={() => setConfirm("cancel")}>
            <Icon id="x" size={16} />
            Cancelar campaña
          </button>
        )}
      </PageHeader>

      {campaign.status === "scheduled" && campaign.scheduledFor && (
        <p className="cp-overview">
          <Icon id="clock" size={16} /> Programada para el <strong>{formatDateTime(campaign.scheduledFor, tz)}</strong>.
        </p>
      )}

      {!draft && (
        <ul className="cp-kpis" aria-label="Resultados">
          <Kpi label="Destinatarios" value={campaign.totalRecipients} />
          <Kpi label="Enviadas" value={c.sent} />
          {c.pending > 0 && <Kpi label="Por enviar" value={c.pending} />}
          <Kpi label="Omitidas" value={c.skipped} />
          {c.failed > 0 && <Kpi label="Fallidas" value={c.failed} />}
          <Kpi label="Respondieron" value={campaign.results.replied} />
          <Kpi label={`${capitalize(t.appointments)} agendadas`} value={campaign.results.appointments} />
        </ul>
      )}

      <section className="card cp-section" aria-labelledby="cp-detail-message">
        <h2 id="cp-detail-message" className="card-title">
          Mensaje
        </h2>
        <p className="cp-message-box">{campaign.message}</p>
        <p className="settings-help">
          <strong>A quiénes:</strong> {segmentSummary(campaign.segment, { status: (s) => CLIENT_STATUS_LABELS[s] })}
          {campaign.segment.excludeUpcoming !== false ? `, sin los que ya tienen una ${t.appointment} próxima` : ""}.
        </p>
      </section>

      {!draft && (
        <section className="card cp-section" aria-labelledby="cp-detail-recipients">
          <h2 id="cp-detail-recipients" className="card-title">
            Destinatarios
          </h2>
          {campaign.recipients.length === 0 ? (
            <p className="muted">Sin destinatarios.</p>
          ) : (
            <div className="cp-table-wrap">
              <table className="cp-recipients">
                <thead>
                  <tr>
                    <th scope="col">{capitalize(t.client)}</th>
                    <th scope="col">Estado</th>
                    <th scope="col">Enviada</th>
                  </tr>
                </thead>
                <tbody>
                  {campaign.recipients.map((r) => (
                    <tr key={r.clientId}>
                      <td>
                        <Link to={`/clients/${r.clientId}`}>{r.name || "Sin nombre"}</Link>
                      </td>
                      <td>
                        {SEND_STATUS_LABELS[r.status]}
                        {r.error && (r.status === "skipped" || r.status === "failed") ? ` · ${SKIP_REASONS[r.error] ?? r.error}` : ""}
                      </td>
                      <td className="tnum">{r.sentAt ? formatDateTime(r.sentAt, tz) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {campaign.totalRecipients > campaign.recipients.length && (
            <p className="settings-help">Se muestran los primeros {campaign.recipients.length} de {campaign.totalRecipients}.</p>
          )}
        </section>
      )}

      {launching && <LaunchDialog campaign={campaign} onClose={() => setLaunching(false)} />}

      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} title={confirm === "delete" ? "¿Borrar el borrador?" : "¿Cancelar la campaña?"}>
        <p>
          {confirm === "delete"
            ? "Se borra el borrador. No se le mandó nada a nadie."
            : "Lo que todavía no se mandó queda sin enviar. Lo ya enviado no se puede deshacer."}
        </p>
        <FormError message={cancel.isError ? errorMessage(cancel.error) : remove.isError ? errorMessage(remove.error) : null} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setConfirm(null)}>
            Volver
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={cancel.isPending || remove.isPending}
            onClick={() => {
              if (confirm === "delete") remove.mutate();
              else
                cancel.mutate(undefined, {
                  onSuccess: () => {
                    setConfirm(null);
                    showToast("Cancelamos la campaña.");
                  },
                });
            }}
          >
            {confirm === "delete" ? "Sí, borrar" : "Sí, cancelar"}
          </button>
        </div>
      </Dialog>
    </>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <li className="card cp-kpi">
      <span className="cp-kpi-label">{label}</span>
      <span className="cp-kpi-value tnum">{value}</span>
    </li>
  );
}

function LaunchDialog({ campaign, onClose }: { campaign: CampaignDetail; onClose: () => void }) {
  const me = useSession();
  const tz = me.business.timezone;
  const { showToast } = useToast();
  const [mode, setMode] = useState<"now" | "later">("now");
  const [date, setDate] = useState(todayIn(tz));
  const [time, setTime] = useState("09:00");
  const launch = useCampaignMutation((scheduledFor: string | null) => campaignsApi.launch(campaign.id, scheduledFor));
  const scheduledIso = mode === "later" && date && time ? zonedToIso(date, time, tz) : null;
  const inPast = scheduledIso !== null && Date.parse(scheduledIso) <= Date.now();

  return (
    <Dialog open onClose={onClose} title="Lanzar la campaña">
      <p>
        Se arma la lista con quienes <strong>hoy</strong> aceptan promociones y cumplen el segmento, y se les manda la plantilla de marketing con tu mensaje. Lo
        enviado no se puede deshacer.
      </p>
      <fieldset className="cp-launch-choice">
        <legend className="field-label">¿Cuándo?</legend>
        <label className="check-row">
          <input type="radio" name="cp-when" checked={mode === "now"} onChange={() => setMode("now")} />
          <span>Ahora</span>
        </label>
        <label className="check-row">
          <input type="radio" name="cp-when" checked={mode === "later"} onChange={() => setMode("later")} />
          <span>Programarla</span>
        </label>
      </fieldset>
      {mode === "later" && (
        <div className="form-grid">
          <TextField label="Día" type="date" value={date} min={todayIn(tz)} onChange={(e) => setDate(e.target.value)} />
          <TextField label="Hora" type="time" value={time} onChange={(e) => setTime(e.target.value)} error={inPast ? "Elegí una hora que no haya pasado." : undefined} />
        </div>
      )}
      <FormError message={launch.isError ? errorMessage(launch.error, "No pudimos lanzar la campaña.") : null} />
      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Volver
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={launch.isPending || (mode === "later" && (!scheduledIso || inPast))}
          onClick={() =>
            launch.mutate(scheduledIso, {
              onSuccess: (saved) => {
                showToast(saved?.status === "scheduled" ? "Campaña programada." : "Campaña lanzada: se está mandando.");
                onClose();
              },
            })
          }
        >
          {launch.isPending ? "Lanzando…" : mode === "now" ? "Mandar ahora" : "Programar"}
        </button>
      </div>
    </Dialog>
  );
}
