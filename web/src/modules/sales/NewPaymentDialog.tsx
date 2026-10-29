import { useEffect, useId, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ALL_LOCATIONS, useActiveLocation } from "../../app/location";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { api, errorMessage, isApiError } from "../../lib/api";
import { currencySymbol, formatCents, parseAmountToCents } from "../../lib/money";
import Dialog from "../../ui/Dialog";
import { FormError, SelectField, TextField } from "../../ui/Field";
import { useToast } from "../../ui/Toast";
import { registeredLabel } from "./format";
import { salesApi, usePaymentMethods, useSalesInvalidation, type ChargeKind } from "./salesApi";

// Cobro suelto a un cliente, sin cita ("+ Nuevo → Cobro" y Ventas › Cobros): p. ej. una
// seña antes de agendar. No tiene tope (no hay saldo contra el cual medirlo).

interface ClientOption {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function NewPaymentDialog({ open, onClose }: Props) {
  const me = useSession();
  const t = terminologyOf(me);
  const currency = me.business.currency;
  const { showToast } = useToast();
  const { selected } = useActiveLocation();
  const methods = usePaymentMethods(open);
  const invalidate = useSalesInvalidation();
  const active = (methods.data ?? []).filter((m) => m.active);

  const [client, setClient] = useState<ClientOption | null>(null);
  const [locationId, setLocationId] = useState("");
  const [kind, setKind] = useState<ChargeKind>("payment");
  const [amount, setAmount] = useState("");
  const [methodId, setMethodId] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const mutation = useMutation({
    mutationFn: salesApi.chargeClient,
    onSuccess: (payment) => {
      invalidate();
      showToast(`${registeredLabel(payment.kind)}: ${formatCents(payment.amountCents, currency)} de ${payment.client?.name ?? `el ${t.client}`}.`);
      onClose();
    },
  });

  useEffect(() => {
    if (!open) return;
    setClient(null);
    setLocationId(selected !== ALL_LOCATIONS ? selected : (me.locations[0]?.id ?? ""));
    setKind("payment");
    setAmount("");
    setNote("");
    setErrors({});
    mutation.reset();
  }, [open]);
  useEffect(() => {
    if (open && !active.some((m) => m.id === methodId)) setMethodId(active[0]?.id ?? "");
  }, [open, methods.data]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    const cents = parseAmountToCents(amount);
    if (!client) next.client = `Elegí el ${t.client}.`;
    if (!cents) next.amount = "Escribí un monto mayor que cero.";
    if (!methodId) next.method = "Elegí el método de pago.";
    if (!locationId) next.location = `Elegí la ${t.location}.`;
    setErrors(next);
    if (Object.keys(next).length > 0 || !client || !cents) return;
    mutation.mutate({ clientId: client.id, locationId, kind, amountCents: cents, methodId, note: note.trim() || null });
  }

  const apiError = isApiError(mutation.error) ? mutation.error : null;
  const fieldShown = apiError !== null && ["clientId", "locationId", "amountCents", "methodId"].some((f) => apiError.fieldError(f));
  return (
    <Dialog open={open} onClose={onClose} title="Nuevo cobro">
      <form onSubmit={onSubmit} noValidate>
        <p className="settings-help">Un cobro o una seña sin {t.appointment} (para cobrar una {t.appointment}, abrila en la Agenda o en Pendientes).</p>
        <ClientSearch value={client} onChange={setClient} open={open} error={errors.client ?? apiError?.fieldError("clientId")} />
        {me.locations.length > 1 && (
          <SelectField
            label={capitalize(t.location)}
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            options={me.locations.map((l) => ({ value: l.id, label: l.name }))}
            error={errors.location ?? apiError?.fieldError("locationId")}
          />
        )}
        <fieldset className="field sales-kind">
          <legend className="field-label">Tipo</legend>
          <label className="check-row">
            <input type="radio" name="loose-kind" checked={kind === "payment"} onChange={() => setKind("payment")} />
            <span>Cobro</span>
          </label>
          <label className="check-row">
            <input type="radio" name="loose-kind" checked={kind === "deposit"} onChange={() => setKind("deposit")} />
            <span>
              Seña<small>Un adelanto antes de agendar.</small>
            </span>
          </label>
        </fieldset>
        <div className="form-grid">
          <TextField
            label={`Monto (${currencySymbol(currency)})`}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={errors.amount ?? apiError?.fieldError("amountCents")}
          />
          <SelectField
            label="Método de pago"
            value={methodId}
            onChange={(e) => setMethodId(e.target.value)}
            options={active.length ? active.map((m) => ({ value: m.id, label: m.name })) : [{ value: "", label: methods.isPending ? "Cargando…" : "Sin métodos activos" }]}
            error={errors.method ?? apiError?.fieldError("methodId")}
          />
        </div>
        <TextField label="Nota (opcional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        <FormError message={mutation.isError && !fieldShown ? errorMessage(mutation.error) : null} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Registrando…" : kind === "deposit" ? "Registrar seña" : "Registrar cobro"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Buscar un cliente por nombre o teléfono (`GET /clients?q=`). */
function ClientSearch({ value, onChange, open, error }: { value: ClientOption | null; onChange: (c: ClientOption | null) => void; open: boolean; error?: string }) {
  const me = useSession();
  const t = terminologyOf(me);
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const listId = useId();

  useEffect(() => {
    if (!open) {
      setDraft("");
      setQ("");
    }
  }, [open]);
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(draft.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const results = useQuery({
    queryKey: ["clients", me.business.id, "sales-search", q],
    queryFn: () => api.get<{ items: ClientOption[] }>(`/clients?${new URLSearchParams({ q, sort: "name", limit: "8" }).toString()}`),
    enabled: open && !value && q.length > 0,
  });

  if (value) {
    return (
      <div className="field">
        <p className="field-label">{capitalize(t.client)}</p>
        <div className="picked-client">
          <div>
            <p className="picked-client-name">{value.name}</p>
            {value.phone && <p className="muted">{value.phone}</p>}
          </div>
          <button type="button" className="link-button" onClick={() => onChange(null)}>
            Cambiar
          </button>
        </div>
      </div>
    );
  }

  const options = results.data?.items ?? [];
  return (
    <div>
      <TextField
        label={`Buscar ${t.client}`}
        type="search"
        autoComplete="off"
        placeholder="Nombre o teléfono"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-controls={listId}
        error={error}
      />
      <div id={listId} className="client-picker-results" aria-live="polite">
        {q.length === 0 ? null : results.isPending ? (
          <p className="muted">Buscando…</p>
        ) : results.isError ? (
          <p className="field-error">{errorMessage(results.error)}</p>
        ) : options.length === 0 ? (
          <p className="muted">
            No encontramos {t.clients} con «{q}».
          </p>
        ) : (
          <ul className="client-picker-list">
            {options.map((c) => (
              <li key={c.id}>
                <button type="button" className="client-picker-option" onClick={() => onChange(c)}>
                  <span className="client-picker-name">{c.name}</span>
                  <span className="muted">{c.phone || c.email || "Sin teléfono"}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
