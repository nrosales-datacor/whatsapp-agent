import { initials, safeLogoUrl } from "../../lib/branding";
import Icon from "../../ui/Icons";
import Menu from "../../ui/Menu";
import { roleLabel, terminologyOf } from "../navigation";
import { useSession, useSwitchBusiness } from "../session";

interface Props {
  /** "full": logo + nombre (menú lateral). "compact": solo el logo (encabezado móvil). */
  variant: "full" | "compact";
}

function BrandChip({ name, logoUrl }: { name: string; logoUrl: string | undefined }) {
  const logo = safeLogoUrl(logoUrl);
  return logo ? (
    <img src={logo} alt="" className="brand-chip brand-logo" />
  ) : (
    <span className="brand-chip" aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/**
 * Marca del negocio activo. Si el usuario pertenece a varios negocios, es además el
 * selector de negocio (cambia la sesión con `POST /auth/switch-business`).
 */
export default function BusinessSwitcher({ variant }: Props) {
  const me = useSession();
  const t = terminologyOf(me);
  const switchBusiness = useSwitchBusiness();
  const { business } = me;
  const canSwitch = me.memberships.length > 1;

  const content = (
    <>
      <BrandChip name={business.name} logoUrl={business.branding?.logoUrl} />
      <span className={variant === "full" ? "brand-name" : "visually-hidden"}>{business.name}</span>
      {canSwitch && variant === "full" && (
        <span className="brand-switch-icon">
          <Icon id="chevronsUpDown" size={16} />
        </span>
      )}
    </>
  );

  if (!canSwitch) {
    return <div className={`brand brand-${variant}`}>{content}</div>;
  }

  return (
    <Menu
      ariaLabel={`Negocio: ${business.name}. Cambiar de negocio`}
      buttonClassName={`brand brand-${variant} brand-button`}
      buttonContent={content}
      align="start"
      header={<span className="menu-header-title">Cambiar de negocio</span>}
      items={me.memberships.map((m) => ({
        key: m.businessId,
        label: m.businessName,
        hint: roleLabel(m.role, t),
        icon: "building",
        current: m.businessId === business.id,
        disabled: switchBusiness.isPending,
        onSelect: () => {
          if (m.businessId !== business.id) switchBusiness.mutate(m.businessId);
        },
      }))}
    />
  );
}
