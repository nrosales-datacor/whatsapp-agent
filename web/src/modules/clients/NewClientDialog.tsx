import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { capitalize, terminologyOf } from "../../app/navigation";
import { useSession } from "../../app/session";
import { errorMessage, isApiError } from "../../lib/api";
import Dialog from "../../ui/Dialog";
import { FormError, TextField } from "../../ui/Field";
import { useToast } from "../../ui/Toast";
import { useCreateClient } from "./clientsApi";

interface Props {
  open: boolean;
  onClose: () => void;
}

type Field = "name" | "phone" | "email";
const EMPTY: Record<Field, string> = { name: "", phone: "", email: "" };
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Alta rápida de un cliente: nombre, teléfono y correo (el resto se completa en la ficha,
 * adonde se va al guardar). El teléfono se escribe como sea: el backend lo normaliza con
 * el país del negocio y avisa si ya es de otro cliente.
 */
export default function NewClientDialog({ open, onClose }: Props) {
  const me = useSession();
  const t = terminologyOf(me);
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [form, setForm] = useState(EMPTY);
  const [localErrors, setLocalErrors] = useState<Partial<Record<Field, string>>>({});
  const mutation = useCreateClient(me.business.id);

  function close() {
    setForm(EMPTY);
    setLocalErrors({});
    mutation.reset();
    onClose();
  }

  function set(key: Field, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setLocalErrors((e) => ({ ...e, [key]: undefined }));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mutation.isPending) return;
    const errors: Partial<Record<Field, string>> = {};
    if (!form.name.trim()) errors.name = "Escribí el nombre.";
    if (form.email.trim() && !RE_EMAIL.test(form.email.trim())) errors.email = "Escribí un correo válido.";
    setLocalErrors(errors);
    if (Object.keys(errors).length > 0) return;
    mutation.mutate(
      { name: form.name.trim(), phone: form.phone.trim() || null, email: form.email.trim() || null },
      {
        onSuccess: (created) => {
          showToast(`${capitalize(t.client)} «${created.name}» guardado.`);
          close();
          navigate(`/clients/${created.id}`);
        },
      },
    );
  }

  const apiError = isApiError(mutation.error) ? mutation.error : null;
  const phoneTaken = apiError?.code === "phone_taken" ? apiError.message : undefined;
  const errorFor = (key: Field) => localErrors[key] ?? apiError?.fieldError(key) ?? (key === "phone" ? phoneTaken : undefined);
  const hasFieldErrors = apiError ? Object.keys(apiError.fields).length > 0 || Boolean(phoneTaken) : false;
  const formError = mutation.isError && !hasFieldErrors ? errorMessage(mutation.error) : null;

  return (
    <Dialog open={open} onClose={close} title={`Nuevo ${t.client}`}>
      <form onSubmit={onSubmit} noValidate>
        <TextField
          label="Nombre"
          name="name"
          autoComplete="off"
          required
          autoFocus
          value={form.name}
          error={errorFor("name")}
          onChange={(e) => set("name", e.target.value)}
        />
        <TextField
          label="Teléfono"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          placeholder="8888 7777"
          hint="Si es de otro país, empezá con + y el código del país."
          value={form.phone}
          error={errorFor("phone")}
          onChange={(e) => set("phone", e.target.value)}
        />
        <TextField
          label="Correo (opcional)"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="off"
          value={form.email}
          error={errorFor("email")}
          onChange={(e) => set("email", e.target.value)}
        />
        <FormError message={formError} />
        <div className="client-form-actions">
          <button type="button" className="btn btn-secondary" onClick={close}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Guardando…" : `Guardar ${t.client}`}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
