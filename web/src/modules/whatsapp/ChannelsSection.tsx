import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage, IS_MOCK_API, isApiError } from "../../lib/api";
import ErrorState from "../../ui/ErrorState";
import { FormError, SelectField, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { formatPhone } from "../clients/format";
import { EmbeddedSignupError, launchEmbeddedSignup } from "./embeddedSignup";
import { useChannels, whatsappApi, whatsappKeys, type Channel, type ChannelPatch, type ChannelStatus, type ChannelTemplates } from "./whatsappApi";

const STATUS: Record<ChannelStatus, { label: string; className: string }> = {
  connected: { label: "Conectado", className: "badge" },
  token_expired: { label: "Acceso vencido", className: "badge badge-warning" },
  disconnected: { label: "Desconectado", className: "badge badge-muted" },
};

const TEMPLATE_FIELDS: readonly { key: keyof ChannelTemplates; label: string; hint: string }[] = [
  { key: "reminder", label: "Plantilla de recordatorio", hint: "La que usa el recordatorio de la cita del día siguiente." },
  { key: "reopen", label: "Plantilla de reapertura", hint: "Para escribirle a un cliente cuando pasaron más de 24 horas (botón «Reabrir con plantilla»)." },
  { key: "marketing", label: "Plantilla de marketing", hint: "Para campañas. Opcional." },
];

const ALL = "";

/** Números de WhatsApp del negocio: conectar (Embedded Signup), probar, sucursal y plantillas. */
export default function ChannelsSection() {
  const query = useChannels();
  const qc = useQueryClient();
  const { showToast } = useToast();

  const connect = useMutation({
    mutationFn: async () => {
      const config = await whatsappApi.signupConfig();
      // En el modo de prueba no hay Meta: se simula que la persona completó el popup.
      const code = IS_MOCK_API ? "mock-code" : await launchEmbeddedSignup(config);
      return whatsappApi.connect(code);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: whatsappKeys.channels });
      showToast("Número conectado. Asignale la sucursal y las plantillas aprobadas.");
    },
    onError: (error) => showToast(error instanceof EmbeddedSignupError ? error.message : errorMessage(error, "No pudimos conectar el número.")),
  });

  return (
    <section className="card wa-settings-card" aria-labelledby="wa-channels-title">
      <div className="wa-card-head">
        <div>
          <h2 id="wa-channels-title" className="card-title">
            Números de WhatsApp
          </h2>
          <p className="settings-help">
            El número por el que atiende el agente. Al conectarlo se abre una ventana de Meta para elegir o crear la cuenta de WhatsApp
            Business; el número deja de funcionar en la app de WhatsApp del celular.
          </p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => connect.mutate()} disabled={connect.isPending}>
          <Icon id="plus" size={16} />
          {connect.isPending ? "Conectando…" : "Conectar un número"}
        </button>
      </div>

      {query.isPending ? (
        <div className="clients-loading" role="status">
          <div className="spinner" aria-hidden="true" />
          <span>Cargando los números…</span>
        </div>
      ) : query.isError ? (
        <ErrorState message={errorMessage(query.error, "No pudimos cargar los números.")} onRetry={() => void query.refetch()} />
      ) : query.data.length === 0 ? (
        <p className="muted wa-empty-note">Todavía no hay ningún número conectado. Conectá uno para que el agente empiece a responder.</p>
      ) : (
        <ul className="wa-channels">
          {query.data.map((channel) => (
            <li key={channel.id}>
              <ChannelItem channel={channel} onReconnect={() => connect.mutate()} reconnecting={connect.isPending} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function toDraft(channel: Channel): ChannelPatch {
  return { locationId: channel.locationId, templates: { ...channel.templates } };
}

function ChannelItem({ channel, onReconnect, reconnecting }: { channel: Channel; onReconnect: () => void; reconnecting: boolean }) {
  const me = useSession();
  const t = terminologyOf(me);
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [draft, setDraft] = useState<ChannelPatch>(() => toDraft(channel));
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(channel));
  const status = STATUS[channel.status];
  const phone = formatPhone(channel.phoneNumber);

  const locationOptions = [
    { value: ALL, label: `Todas las ${t.locations}` },
    ...me.locations.map((l) => ({ value: l.id, label: l.name })),
    ...(channel.locationId && !me.locations.some((l) => l.id === channel.locationId) ? [{ value: channel.locationId, label: `Otra ${t.location}` }] : []),
  ];

  const save = useMutation({
    mutationFn: () => whatsappApi.updateChannel(channel.id, { locationId: draft.locationId, templates: draft.templates }),
    onSuccess: (saved) => {
      qc.setQueryData<Channel[]>(whatsappKeys.channels, (list) => list?.map((c) => (c.id === channel.id ? (saved ?? { ...c, ...draft }) : c)));
      if (saved) setDraft(toDraft(saved));
      showToast(`Guardamos los cambios del ${phone}.`);
    },
  });

  const test = useMutation({
    mutationFn: () => whatsappApi.testChannel(channel.id),
    onSuccess: () => showToast(`La conexión del ${phone} funciona.`),
    onError: (error) => showToast(errorMessage(error, "La prueba del número falló.")),
  });

  const fieldError = (name: string) => (isApiError(save.error) ? save.error.fieldError(name) : undefined);

  return (
    <form
      className="wa-channel"
      aria-label={`Número ${phone}`}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="wa-channel-head">
        <span className="wa-channel-icon" aria-hidden="true">
          <Icon id="phone" size={18} />
        </span>
        <div className="wa-channel-title">
          <span className="wa-channel-phone tnum">{phone}</span>
          <span className="muted">{channel.displayName}</span>
        </div>
        <span className={status.className}>{status.label}</span>
      </div>

      {channel.status !== "connected" && (
        <div className="readonly-notice wa-channel-warning">
          <Icon id="alert" size={16} />
          <span>
            {channel.status === "token_expired"
              ? "El acceso de Meta a este número venció: el agente no puede responder hasta que lo volvás a conectar."
              : "Este número está desconectado: el agente no responde por él."}
          </span>
          <button type="button" className="link-button" onClick={onReconnect} disabled={reconnecting}>
            Volver a conectar
          </button>
        </div>
      )}

      {me.locations.length > 1 && (
        <SelectField
          label={capitalize(t.location)}
          hint={`Las conversaciones de este número se ven en esa ${t.location}.`}
          options={locationOptions}
          value={draft.locationId ?? ALL}
          onChange={(e) => setDraft((d) => ({ ...d, locationId: e.target.value || null }))}
          error={fieldError("locationId")}
        />
      )}

      <fieldset className="wa-templates">
        <legend>Plantillas aprobadas en Meta</legend>
        <div className="form-grid">
          {TEMPLATE_FIELDS.map((f) => (
            <TextField
              key={f.key}
              label={f.label}
              hint={f.hint}
              placeholder="nombre_de_la_plantilla"
              className="wa-mono"
              spellCheck={false}
              autoCapitalize="off"
              value={draft.templates[f.key]}
              onChange={(e) => setDraft((d) => ({ ...d, templates: { ...d.templates, [f.key]: e.target.value } }))}
              error={fieldError(`templates.${f.key}`)}
            />
          ))}
        </div>
      </fieldset>

      <FormError message={save.isError && !Object.keys(isApiError(save.error) ? save.error.fields : {}).length ? errorMessage(save.error) : null} />
      <div className="wa-channel-actions">
        <button type="button" className="btn btn-secondary btn-small" onClick={() => test.mutate()} disabled={test.isPending || channel.status !== "connected"}>
          <Icon id="send" size={16} />
          {test.isPending ? "Probando…" : "Probar conexión"}
        </button>
        <button type="submit" className="btn btn-primary btn-small" disabled={!dirty || save.isPending}>
          {save.isPending ? "Guardando…" : "Guardar número"}
        </button>
      </div>
    </form>
  );
}
