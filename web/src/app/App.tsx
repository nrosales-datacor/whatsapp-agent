import { Navigate, Route, Routes } from "react-router-dom";
import AdminBusinessPage from "../modules/admin/AdminBusinessPage";
import AdminHomePage from "../modules/admin/AdminHomePage";
import AdminLoginPage from "../modules/admin/AdminLoginPage";
import RequireAdmin from "../modules/admin/RequireAdmin";
import AcceptInvitationPage, { InviteRedirect } from "../modules/auth/AcceptInvitationPage";
import ChangePasswordPage from "../modules/auth/ChangePasswordPage";
import ForgotPasswordPage from "../modules/auth/ForgotPasswordPage";
import LoginPage from "../modules/auth/LoginPage";
import ResetPasswordPage from "../modules/auth/ResetPasswordPage";
import CampaignsPage from "../modules/campaigns/CampaignsPage";
import ClientDetailPage from "../modules/clients/ClientDetailPage";
import ClientsPage from "../modules/clients/ClientsPage";
import HomePage from "../modules/home/HomePage";
import ReportsPage from "../modules/reports/ReportsPage";
import SalesPage from "../modules/sales/SalesPage";
import AgendaPage from "../modules/scheduling/AgendaPage";
import SettingsLayout from "../modules/settings/SettingsLayout";
import SettingsSubPage from "../modules/settings/SettingsSubPage";
import AgentSettingsPage from "../modules/whatsapp/AgentSettingsPage";
import InboxPage from "../modules/whatsapp/InboxPage";
import MetricsPage from "../modules/whatsapp/MetricsPage";
import WhatsappLayout from "../modules/whatsapp/WhatsappLayout";
import AppLayout from "./layout/AppLayout";
import NotFoundPage from "./NotFoundPage";
import SectionGate from "./SectionGate";
import { PublicOnly, RequireAuth } from "./session";

// ─────────────────────────────────────────────────────────────────────────────
// Rutas del panel (basename "/panel", ver main.tsx). Las URLs son estables para poder
// enlazar una sección o una ficha desde una notificación push (PLAN-GESTION.md §6).
//
//   Acceso:      /login · /forgot-password · /reset-password?token= (enlace del correo)
//                /accept-invitation?token= (enlace del correo; /invite/:token es alias)
//                /change-password (obligatorio con clave temporal)
//   Panel:       / · /agenda · /clients · /clients/:id · /sales · /reports · /campaigns
//                /whatsapp · /whatsapp/conversations/:id · /whatsapp/metrics · /whatsapp/settings
//                /settings/:page
//   Superadmin:  /admin/login · /admin · /admin/businesses/:id (plan, cobro y pausa)
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicOnly>
            <LoginPage />
          </PublicOnly>
        }
      />
      <Route
        path="/forgot-password"
        element={
          <PublicOnly>
            <ForgotPasswordPage />
          </PublicOnly>
        }
      />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
      <Route path="/invite/:token" element={<InviteRedirect />} />

      <Route path="/admin/login" element={<AdminLoginPage />} />
      <Route path="/admin" element={<RequireAdmin />}>
        <Route index element={<AdminHomePage />} />
        <Route path="businesses/:id" element={<AdminBusinessPage />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Route>

      <Route element={<RequireAuth />}>
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route element={<AppLayout />}>
          <Route
            index
            element={
              <SectionGate id="home">
                <HomePage />
              </SectionGate>
            }
          />
          <Route
            path="agenda"
            element={
              <SectionGate id="agenda">
                <AgendaPage />
              </SectionGate>
            }
          />
          <Route
            path="clients"
            element={
              <SectionGate id="clients">
                <ClientsPage />
              </SectionGate>
            }
          />
          <Route
            path="clients/:id"
            element={
              <SectionGate id="clients">
                <ClientDetailPage />
              </SectionGate>
            }
          />
          <Route
            path="sales"
            element={
              <SectionGate id="sales">
                <SalesPage />
              </SectionGate>
            }
          />
          <Route
            path="reports"
            element={
              <SectionGate id="reports">
                <ReportsPage />
              </SectionGate>
            }
          />
          <Route
            path="whatsapp"
            element={
              <SectionGate id="whatsapp">
                <WhatsappLayout />
              </SectionGate>
            }
          >
            {/* Bandeja: la misma pantalla con o sin chat abierto (no se vuelve a montar la lista). */}
            <Route element={<InboxPage />}>
              <Route index element={null} />
              <Route path="conversations/:id" element={null} />
            </Route>
            <Route path="metrics" element={<MetricsPage />} />
            <Route path="settings" element={<AgentSettingsPage />} />
            <Route path="*" element={<Navigate to="/whatsapp" replace />} />
          </Route>
          <Route
            path="campaigns"
            element={
              <SectionGate id="campaigns">
                <CampaignsPage />
              </SectionGate>
            }
          />
          <Route
            path="settings"
            element={
              <SectionGate id="settings">
                <SettingsLayout />
              </SectionGate>
            }
          >
            <Route index element={<Navigate to="business" replace />} />
            <Route path=":page" element={<SettingsSubPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
