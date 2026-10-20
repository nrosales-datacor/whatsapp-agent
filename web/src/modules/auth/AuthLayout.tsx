import { lazy, Suspense, useLayoutEffect, type ReactNode } from "react";
import { IS_MOCK_API } from "../../lib/api";
import { documentTitle, PRODUCT_NAME } from "../../lib/branding";

// La ayuda con las cuentas de prueba solo existe en modo mock (la rama se elimina del
// build normal junto con el import).
const MockAccountsHint = IS_MOCK_API ? lazy(() => import("./MockAccountsHint")) : null;

interface Props {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  /** Muestra la ayuda de cuentas de prueba (solo en modo mock, en el login). */
  showMockAccounts?: boolean;
}

/**
 * Pantallas de acceso (login, recuperar clave, invitación…): panel de marca a la izquierda
 * y el formulario en una tarjeta a la derecha. En móvil, solo la tarjeta con la marca
 * compacta. Siempre con la marca del producto: todavía no sabemos de qué negocio es.
 */
export default function AuthLayout({ title, intro, children, showMockAccounts }: Props) {
  useLayoutEffect(() => {
    document.title = documentTitle(title);
  }, [title]);

  return (
    <div className="auth-shell">
      <div className="auth-brand" aria-hidden="true">
        <div className="auth-brand-head">
          <span className="brand-chip">SC</span>
          <span className="auth-brand-name">{PRODUCT_NAME}</span>
        </div>
        <div>
          <p className="auth-brand-headline">Agenda, clientes y WhatsApp de tu negocio en un solo lugar.</p>
          <p className="auth-brand-sub">
            Citas, fichas, cobros y un agente de WhatsApp con IA que atiende mientras vos hacés otras cosas.
          </p>
        </div>
        <p className="auth-brand-footer">
          © {new Date().getFullYear()} · {PRODUCT_NAME}
        </p>
      </div>

      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-card-brand">
            <span className="brand-chip" aria-hidden="true">
              SC
            </span>
            <span className="auth-card-product">{PRODUCT_NAME}</span>
          </div>
          <h1 className="auth-title">{title}</h1>
          {intro && <p className="auth-intro">{intro}</p>}
          {children}
        </div>
        {showMockAccounts && MockAccountsHint && (
          <Suspense fallback={null}>
            <MockAccountsHint />
          </Suspense>
        )}
      </main>
    </div>
  );
}
