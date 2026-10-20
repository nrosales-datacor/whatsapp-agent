import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { capitalize, roleLabel, terminologyOf } from "../../app/navigation";
import { ME_QUERY_KEY, useSession } from "../../app/session";
import { errorMessage } from "../../lib/api";
import type { Role } from "../../lib/contract";
import Dialog from "../../ui/Dialog";
import ErrorState from "../../ui/ErrorState";
import { FormError, SelectField, TextField } from "../../ui/Field";
import Icon from "../../ui/Icons";
import { useToast } from "../../ui/Toast";
import { CheckRow, ConfirmDialog, fieldErrorOf, LoadingState, mutationError } from "./common";
import { SETTINGS_KEYS, settingsApi, type LocationView, type Member } from "./settingsApi";

// Configuración > Usuarios y permisos (usa /team/members y /team/invitations, I0.6): quién
// entra al panel, con qué rol y a qué sucursales; invitar, reenviar la invitación,
// cambiar rol/sucursales y desactivar. Solo dueño y administración (lo exige el backend).

const STATUS_LABELS: Record<Member["status"], string> = { active: "Activo", invited: "Invitación pendiente", inactive: "Desactivado" };
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Dialogs = { kind: "invite"; member: Member | null } | { kind: "edit"; member: Member } | { kind: "toggle"; member: Member } | null;

export default function UsersPage() {
  const me = useSession();
  const t = terminologyOf(me);
  const membersQuery = useQuery({ queryKey: SETTINGS_KEYS.members, queryFn: settingsApi.listMembers });
  const locationsQuery = useQuery({ queryKey: SETTINGS_KEYS.locations, queryFn: settingsApi.listLocations });
  const [dialog, setDialog] = useState<Dialogs>(null);
  const close = () => setDialog(null);

  if (membersQuery.isPending) return <LoadingState />;
  if (membersQuery.isError) return <ErrorState message={errorMessage(membersQuery.error, "No pudimos cargar el equipo.")} onRetry={() => void membersQuery.refetch()} />;
  const members = membersQuery.data;
  const locations = locationsQuery.data ?? [];
  const locationName = (id: string) => locations.find((l) => l.id === id)?.name ?? capitalize(t.location);
  // Solo un dueño gestiona a otros dueños.
  const canTouch = (m: Member) => m.userId !== me.user.id && (m.role !== "owner" || me.role === "owner");

  return (
    <div className="settings-stack">
      <div className="settings-toolbar">
        <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: "invite", member: null })}>
          <Icon id="mail" size={16} />
          Invitar a alguien
        </button>
      </div>
      <ul className="settings-list" aria-label="Usuarios del panel">
        {members.map((m) => (
          <li key={m.membershipId} className={"settings-item" + (m.active ? "" : " inactive")}>
            <div className="settings-item-main">
              <span className="settings-item-title">
                {m.name}
                {m.userId === me.user.id && <span className="badge badge-muted">Vos</span>}
                <span className={"badge" + (m.status === "invited" ? " badge-warning" : m.status === "inactive" ? " badge-muted" : "")}>{STATUS_LABELS[m.status]}</span>
                {m.totpEnabled && <span className="badge badge-info">2FA</span>}
              </span>
              <span className="settings-item-meta">{m.email}</span>
              <span className="settings-item-meta">
                {roleLabel(m.role, t)} · {m.allLocations ? `Todas las ${t.locations}` : m.locationIds.map(locationName).join(", ")}
              </span>
            </div>
            <div className="settings-item-actions">
              {m.status === "invited" && (
                <button type="button" className="btn btn-secondary btn-small" onClick={() => setDialog({ kind: "invite", member: m })}>
                  Reenviar<span className="visually-hidden"> la invitación a {m.name}</span>
                </button>
              )}
              {canTouch(m) && (
                <>
                  <button type="button" className="icon-btn" aria-label={`Cambiar el rol o las ${t.locations} de ${m.name}`} onClick={() => setDialog({ kind: "edit", member: m })}>
                    <Icon id="pencil" size={18} />
                  </button>
                  <button type="button" className="btn btn-secondary btn-small" onClick={() => setDialog({ kind: "toggle", member: m })}>
                    {m.active ? "Desactivar" : "Reactivar"}
                    <span className="visually-hidden"> a {m.name}</span>
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {dialog?.kind === "invite" && <InviteDialog resend={dialog.member} locations={locations} onClose={close} />}
      {dialog?.kind === "edit" && <EditMemberDialog member={dialog.member} locations={locations} onClose={close} />}
      {dialog?.kind === "toggle" && <ToggleMemberDialog member={dialog.member} onClose={close} />}
    </div>
  );
}

function roleOptions(myRole: Role, t: ReturnType<typeof terminologyOf>) {
  const roles: Role[] = myRole === "owner" ? ["owner", "admin", "front_desk", "staff"] : ["admin", "front_desk", "staff"];
  return roles.map((r) => ({ value: r, label: roleLabel(r, t) }));
}

function LocationChecks({ role, value, locations, onChange }: { role: Role; value: string[]; locations: LocationView[]; onChange: (ids: string[]) => void }) {
  const me = useSession();
  const t = terminologyOf(me);
  if (role === "owner") return <p className="settings-help">{`Un dueño entra a todas las ${t.locations}.`}</p>;
  if (locations.length <= 1) return null;
  return (
    <fieldset className="field">
      <legend>{`¿A qué ${t.locations} entra?`}</legend>
      <p className="settings-help">Sin marcar ninguna = todas.</p>
      <div className="check-list">
        {locations.map((l) => (
          <CheckRow key={l.id} label={l.name} checked={value.includes(l.id)} onChange={(v) => onChange(v ? [...value, l.id] : value.filter((id) => id !== l.id))} />
        ))}
      </div>
    </fieldset>
  );
}

function InviteDialog({ resend, locations, onClose }: { resend: Member | null; locations: LocationView[]; onClose: () => void }) {
  const me = useSession();
  const t = terminologyOf(me);
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [email, setEmail] = useState(resend?.email ?? "");
  const [name, setName] = useState(resend?.name ?? "");
  const [role, setRole] = useState<Role>(resend?.role ?? "staff");
  const [locationIds, setLocationIds] = useState<string[]>(resend?.locationIds ?? []);
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => settingsApi.invite({ email: email.trim(), name: name.trim() || undefined, role, locationIds: role === "owner" ? [] : locationIds }),
    onSuccess: (member) => {
      void qc.invalidateQueries({ queryKey: SETTINGS_KEYS.members });
      showToast(`Listo, le mandamos la invitación a ${member.email}.`);
      onClose();
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!RE_EMAIL.test(email.trim())) return setLocalError("Escribí un correo válido.");
    setLocalError(null);
    mutation.mutate();
  }

  return (
    <Dialog open onClose={onClose} title={resend ? `Reenviar invitación a ${resend.name}` : "Invitar a alguien"}>
      <form onSubmit={onSubmit} noValidate>
        <TextField label="Correo" type="email" autoComplete="off" value={email} readOnly={!!resend} autoFocus={!resend} error={localError ?? fieldErrorOf(mutation.error, "email")} onChange={(e) => setEmail(e.target.value)} />
        <TextField label="Nombre (opcional)" value={name} maxLength={120} error={fieldErrorOf(mutation.error, "name")} onChange={(e) => setName(e.target.value)} />
        <SelectField label="Rol" value={role} options={roleOptions(me.role, t)} error={fieldErrorOf(mutation.error, "role")} onChange={(e) => setRole(e.target.value as Role)} />
        <LocationChecks role={role} value={locationIds} locations={locations} onChange={setLocationIds} />
        <p className="settings-help">Le llega un correo con un enlace para elegir su clave (vale 7 días). Si ya tiene cuenta, entra con la suya.</p>
        <FormError message={mutationError(mutation.error)} />
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? "Enviando…" : "Enviar invitación"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function EditMemberDialog({ member, locations, onClose }: { member: Member; locations: LocationView[]; onClose: () => void }) {
  const me = useSession();
  const t = terminologyOf(me);
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [role, setRole] = useState<Role>(member.role);
  const [locationIds, setLocationIds] = useState<string[]>(member.locationIds);
  const mutation = useMutation({
    mutationFn: () => settingsApi.updateMember(member.membershipId, { role, locationIds: role === "owner" ? [] : locationIds }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SETTINGS_KEYS.members });
      void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
      showToast(`Listo, los permisos de ${member.name} quedaron guardados.`);
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={`Permisos de ${member.name}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
        noValidate
      >
        <SelectField label="Rol" value={role} options={roleOptions(me.role, t)} onChange={(e) => setRole(e.target.value as Role)} />
        <LocationChecks role={role} value={locationIds} locations={locations} onChange={setLocationIds} />
        {role !== member.role && <p className="settings-help">Al cambiar el rol, su sesión se cierra y vuelve a entrar con los permisos nuevos.</p>}
        <FormError message={mutationError(mutation.error)} />
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

function ToggleMemberDialog({ member, onClose }: { member: Member; onClose: () => void }) {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const deactivate = member.active;
  const mutation = useMutation({
    mutationFn: () => settingsApi.updateMember(member.membershipId, { active: !deactivate }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SETTINGS_KEYS.members });
      showToast(deactivate ? `${member.name} ya no puede entrar al panel.` : `${member.name} puede volver a entrar al panel.`);
      onClose();
    },
  });
  return (
    <ConfirmDialog
      open
      title={deactivate ? `¿Desactivar a ${member.name}?` : `¿Reactivar a ${member.name}?`}
      confirmLabel={deactivate ? "Desactivar" : "Reactivar"}
      danger={deactivate}
      pending={mutation.isPending}
      error={mutationError(mutation.error)}
      onConfirm={() => mutation.mutate()}
      onClose={onClose}
    >
      <p>{deactivate ? "Se cierran sus sesiones abiertas y no puede volver a entrar hasta que lo reactives." : "Vuelve a entrar con su clave de siempre."}</p>
    </ConfirmDialog>
  );
}
