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
import SignupPage from "../modules/auth/SignupPage";
import VerifyEmailPage from "../modules/auth/VerifyEmailPage";
import CampaignsPage from "../modules/campaigns/CampaignsPage";
import ClientDetailPage from "../modules/clients/ClientDetailPage";
import ClientsPage from "../modules/clients/ClientsPage";
import HomePage from "../modules/home/HomePage";
import AdminMetricsPage from "../modules/admin/AdminMetricsPage";
import ReportsPage from "../modules/reports/ReportsPage";
import { ChannelsReportView, ClientsReportView, SalesReportView, ServicesReportView, StaffReportView } from "../modules/reports/ReportViews";
import CommissionsPage from "../modules/sales/CommissionsPage";
import DailySummaryPage from "../modules/sales/DailySummaryPage";
import PaymentsPage from "../modules/sales/PaymentsPage";
import PendingPage from "../modules/sales/PendingPage";
import SalesLayout from "../modules/sales/SalesLayout";
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
//                /signup (alta self-service, si está abierta) · /verify-email?token= (enlace del correo)
//   Panel:       / · /agenda · /clients · /clients/:id · /campaigns
//                /reports · /reports/services · /reports/staff · /reports/clients · /reports/channels
//                /sales · /sales/pending · /sales/today · /sales/commissions
//                /whatsapp · /whatsapp/conversations/:id · /whatsapp/metrics · /whatsapp/settings
//                /settings/:page
//   Superadmin:  /admin/login · /admin · /admin/businesses/:id (plan, cobro, pausa y uso) · /admin/metrics
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
      <Route
        path="/signup"
        element={
          <PublicOnly>
            <SignupPage />
          </PublicOnly>
        }
      />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
      <Route path="/invite/:token" element={<InviteRedirect />} />

      <Route path="/admin/login" element={<AdminLoginPage />} />
      <Route path="/admin" element={<RequireAdmin />}>
        <Route index element={<AdminHomePage />} />
        <Route path="businesses/:id" element={<AdminBusinessPage />} />
        <Route path="metrics" element={<AdminMetricsPage />} />
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
                <SalesLayout />
              </SectionGate>
            }
          >
            {/* Cobros · Pendientes · Resumen del día · Comisiones ("Mis comisiones" para el profesional). */}
            <Route index element={<PaymentsPage />} />
            <Route path="pending" element={<PendingPage />} />
            <Route path="today" element={<DailySummaryPage />} />
            <Route path="commissions" element={<CommissionsPage />} />
            <Route path="*" element={<Navigate to="/sales" replace />} />
          </Route>
          <Route
            path="reports"
            element={
              <SectionGate id="reports">
                <ReportsPage />
              </SectionGate>
            }
          >
            {/* Ventas · Servicios · Profesionales · Clientes · Canales (período en ?days o ?from&to). */}
            <Route index element={<SalesReportView />} />
            <Route path="services" element={<ServicesReportView />} />
            <Route path="staff" element={<StaffReportView />} />
            <Route path="clients" element={<ClientsReportView />} />
            <Route path="channels" element={<ChannelsReportView />} />
            <Route path="*" element={<Navigate to="/reports" replace />} />
          </Route>
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
