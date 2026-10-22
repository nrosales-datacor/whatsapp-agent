import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import Dialog from "../../ui/Dialog";
import EmptyState from "../../ui/EmptyState";
import ErrorState from "../../ui/ErrorState";
import { FormError, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { CheckRow, ConfirmDialog, fieldErrorOf, LoadingState, moveId, mutationError, OrderButtons, ReadOnlyNotice } from "../settings/common";
import { canManageSettings } from "../settings/settingsApi";
import { salesApi, salesKeys, usePaymentMethods, type PaymentMethod } from "./salesApi";

// Configuración › Métodos de pago (plan Pro): los que se ofrecen al cobrar, en su orden.
// Alta, renombrar, desactivar y borrar (con pagos, el backend lo desactiva). El negocio
// nace con efectivo, SINPE Móvil, tarjeta y transferencia.

type Dialogs = { kind: "edit"; method: PaymentMethod | null } | { kind: "delete"; method: PaymentMethod } | null;

export default function PaymentMethodsPage() {
  const me = useSession();
  const canEdit = canManageSettings(me);
  const query = usePaymentMethods();
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const reorder = useMutation({
    mutationFn: salesApi.reorderMethods,
    onSuccess: (methods) => qc.setQueryData(salesKeys.methods, methods),
    onError: () => showToast("No pudimos guardar el orden. Probá de nuevo."),
  });

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={errorMessage(query.error, "No pudimos cargar los métodos de pago.")} onRetry={() => void query.refetch()} />;
  const methods = reorder.isPending && reorder.variables ? reorder.variables.map((id) => query.data.find((m) => m.id === id)).filter((m): m is PaymentMethod => Boolean(m)) : query.data;
  const ids = methods.map((m) => m.id);

  return (
    <div className="settings-stack">
      {!canEdit && <ReadOnlyNotice />}
      {canEdit && (
        <div className="settings-toolbar">
          <span />
          <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: "edit", method: null })}>
            <Icon id="plus" size={16} />
            Nuevo método
          </button>
        </div>
      )}
      {methods.length === 0 ? (
        <EmptyState icon="receipt" title="Sin métodos de pago" help="Agregá al menos uno para poder registrar cobros." />
      ) : (
        <ul className="settings-list" aria-label="Métodos de pago">
          {methods.map((m, index) => (
            <li key={m.id} className={"settings-item" + (m.active ? "" : " inactive")}>
              <div className="settings-item-main">
                <span className="settings-item-title">
                  {m.name}
                  {!m.active && <span className="badge badge-muted">Inactivo</span>}
                </span>
                <span className="settings-item-meta">{m.active ? "Se ofrece al cobrar" : "No se ofrece al cobrar (queda en los movimientos)"}</span>
              </div>
              {canEdit && (
                <div className="settings-item-actions">
                  <OrderButtons index={index} count={methods.length} label={m.name} disabled={reorder.isPending} onMove={(from, to) => reorder.mutate(moveId(ids, from, to))} />
                  <button type="button" className="icon-btn" aria-label={`Editar ${m.name}`} onClick={() => setDialog({ kind: "edit", method: m })}>
                    <Icon id="pencil" size={18} />
                  </button>
                  <button type="button" className="icon-btn danger" aria-label={`Eliminar ${m.name}`} onClick={() => setDialog({ kind: "delete", method: m })}>
                    <Icon id="trash" size={18} />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {dialog?.kind === "edit" && <MethodDialog method={dialog.method} onClose={() => setDialog(null)} />}
      {dialog?.kind === "delete" && <DeleteMethodDialog method={dialog.method} onClose={() => setDialog(null)} />}
    </div>
  );
}

function MethodDialog({ method, onClose }: { method: PaymentMethod | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [name, setName] = useState(method?.name ?? "");
  const [active, setActive] = useState(method?.active ?? true);
  const [localError, setLocalError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => (method ? salesApi.updateMethod(method.id, { name: name.trim(), active }) : salesApi.createMethod(name.trim())),
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: salesKeys.methods });
      showToast(method ? `Listo, «${saved.name}» quedó guardado.` : `Listo, «${saved.name}» ya se ofrece al cobrar.`);
      onClose();
    },
  });
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setLocalError("Escribí el nombre.");
    setLocalError(null);
    mutation.mutate();
  }
  return (
    <Dialog open onClose={onClose} title={method ? `Editar ${method.name}` : "Nuevo método de pago"}>
      <form onSubmit={onSubmit} noValidate>
        <TextField label="Nombre" value={name} maxLength={60} autoFocus placeholder="Ej.: Tarjeta de crédito" error={localError ?? fieldErrorOf(mutation.error, "name")} onChange={(e) => setName(e.target.value)} />
        {method && (
          <div className="field">
            <CheckRow label="Activo" hint="Un método inactivo no se ofrece al cobrar." checked={active} onChange={setActive} />
          </div>
        )}
        <FormError message={fieldErrorOf(mutation.error, "name") ? null : mutationError(mutation.error)} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteMethodDialog({ method, onClose }: { method: PaymentMethod; onClose: () => void }) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const mutation = useMutation({
    mutationFn: () => salesApi.deleteMethod(method.id),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: salesKeys.methods });
      showToast(result.deleted ? `«${method.name}» quedó eliminado.` : `«${method.name}» tiene cobros registrados: quedó desactivado.`);
      onClose();
    },
  });
  return (
    <ConfirmDialog
      open
      title={`¿Eliminar ${method.name}?`}
      confirmLabel="Eliminar"
      danger
      pending={mutation.isPending}
      error={mutationError(mutation.error)}
      onConfirm={() => mutation.mutate()}
      onClose={onClose}
    >
      <p>
        Si ya tiene cobros registrados no se borra: queda <strong>desactivado</strong> y se conserva en los movimientos y el resumen del día.
      </p>
    </ConfirmDialog>
  );
}
