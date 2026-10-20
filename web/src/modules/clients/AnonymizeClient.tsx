import { useEffect, useRef, useState, type FormEvent } from "react";
import { terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import Dialog from "../../ui/Dialog";
import { FormError, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { useAnonymizeClient, type ClientDetail } from "./clientsApi";
import { formatPhone, phoneMatches } from "./format";

/**
 * "Eliminar datos del cliente" (derecho de supresión, Ley 8968). Solo la ve el dueño. La
 * confirmación es fuerte: hay que escribir el teléfono del cliente (o su nombre si no tiene
 * teléfono) y el backend lo vuelve a verificar. Las citas y pagos quedan, sin sus datos.
 */
export default function AnonymizeClient({ client }: { client: ClientDetail }) {
  const me = useSession();
  const t = terminologyOf(me);
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const mutation = useAnonymizeClient(me.business.id, client.id);
  const confirmRef = useRef<HTMLInputElement>(null);
  // Al abrir, el foco va a la confirmación (no al botón de cerrar del <dialog>).
  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  const byPhone = Boolean(client.phone);
  const expected = byPhone ? formatPhone(client.phone) : client.name;
  const matches = byPhone
    ? phoneMatches(typed, client.phone ?? "")
    : typed.trim().toLocaleLowerCase("es") === client.name.trim().toLocaleLowerCase("es");

  function close() {
    setOpen(false);
    setTyped("");
    mutation.reset();
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!matches || mutation.isPending) return;
    mutation.mutate(typed, {
      onSuccess: () => {
        close();
        showToast(`Se eliminaron los datos del ${t.client}.`);
      },
    });
  }

  const apiError = isApiError(mutation.error) ? mutation.error : null;
  const fieldError = apiError?.fieldError("confirmation");

  return (
    <section className="card client-danger" aria-labelledby="client-danger-title">
      <h2 id="client-danger-title" className="card-title">
        Eliminar datos del {t.client}
      </h2>
      <p className="muted">
        Si el {t.client} lo pide, borrá sus datos personales: nombre, teléfono, correo, notas y preferencias. Sus{" "}
        {t.appointments} y pagos quedan en el historial, pero sin sus datos. No se puede deshacer.
      </p>
      <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>
        <Icon id="alert" size={16} />
        Eliminar datos del {t.client}
      </button>

      <Dialog open={open} onClose={close} title={`¿Eliminar los datos de ${client.name}?`}>
        <form onSubmit={onSubmit} noValidate>
          <ul className="client-danger-list">
            <li>Se borran su nombre, teléfono, correo, fecha de nacimiento, notas, etiquetas y preferencias.</li>
            <li>
              Sus {t.appointments} y pagos quedan a nombre de «{t.client} eliminado», para que tus números sigan cuadrando.
            </li>
            <li>No se puede deshacer.</li>
          </ul>
          <TextField
            label={byPhone ? `Para confirmar, escribí su teléfono: ${expected}` : `Para confirmar, escribí su nombre: ${expected}`}
            autoComplete="off"
            ref={confirmRef}
            inputMode={byPhone ? "tel" : "text"}
            value={typed}
            error={fieldError}
            onChange={(e) => {
              setTyped(e.target.value);
              if (mutation.isError) mutation.reset();
            }}
          />
          <FormError message={mutation.isError && !fieldError ? errorMessage(mutation.error) : null} />
          <div className="client-form-actions">
            <button type="button" className="btn btn-secondary" onClick={close}>
              Cancelar
            </button>
            <button type="submit" className="btn btn-danger" disabled={!matches || mutation.isPending}>
              {mutation.isPending ? "Eliminando…" : "Eliminar sus datos"}
            </button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
