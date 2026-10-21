import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { initials } from "../../lib/branding";
import { useTheme } from "../../lib/theme";
import TwoFactorDialog from "../../modules/auth/TwoFactorDialog";
import Menu, { type MenuItem } from "../../ui/Menu";
import { roleLabel, terminologyOf } from "../navigation";
import { usePush } from "../push";
import { useLogout, useSession } from "../session";

/** Ítem de notificaciones push según el estado de este navegador (nada si no aplica). */
function pushItems(push: ReturnType<typeof usePush>): MenuItem[] {
  if (!push.relevant) return [];
  switch (push.state) {
    case "off":
      return [{ key: "push", label: "Activar notificaciones", icon: "bell", disabled: push.busy, onSelect: () => void push.enable() }];
    case "on":
      return [{ key: "push", label: "Desactivar notificaciones", icon: "bellOff", disabled: push.busy, onSelect: () => void push.disable() }];
    case "denied":
      return [{ key: "push", label: "Notificaciones bloqueadas", icon: "bellOff", disabled: true, hint: "En el navegador" }];
    default:
      return [];
  }
}

/** Menú de usuario: notificaciones, cambiar clave, 2FA, tema claro/oscuro y salir. */
export default function UserMenu() {
  const me = useSession();
  const push = usePush();
  const t = terminologyOf(me);
  const navigate = useNavigate();
  const logout = useLogout();
  const { theme, toggle } = useTheme();
  const [twoFactorOpen, setTwoFactorOpen] = useState(false);

  return (
    <>
      <Menu
        ariaLabel={`Menú de ${me.user.name}`}
        buttonClassName="avatar-button"
        buttonContent={
          <span className="avatar" aria-hidden="true">
            {initials(me.user.name)}
          </span>
        }
        header={
          <div className="user-summary">
            <span className="user-summary-name">{me.user.name}</span>
            <span className="user-summary-email">{me.user.email}</span>
            <span className="user-summary-role">
              {me.business.name} · {roleLabel(me.role, t)}
            </span>
          </div>
        }
        items={[
          ...pushItems(push),
          { key: "password", label: "Cambiar clave", icon: "key", onSelect: () => navigate("/change-password") },
          {
            key: "totp",
            label: me.user.totpEnabled ? "Desactivar 2FA" : "Activar 2FA",
            icon: "shield",
            onSelect: () => setTwoFactorOpen(true),
          },
          {
            key: "theme",
            label: theme === "dark" ? "Tema claro" : "Tema oscuro",
            icon: theme === "dark" ? "sun" : "moon",
            onSelect: toggle,
          },
          { key: "logout", label: "Salir", icon: "logout", disabled: logout.isPending, onSelect: () => logout.mutate() },
        ]}
      />
      <TwoFactorDialog open={twoFactorOpen} onClose={() => setTwoFactorOpen(false)} />
    </>
  );
}
