import { api } from "../../lib/api";
import type { Invitation, LoginInput, LoginResult, Me, TotpSetup } from "../../lib/contract";

// Endpoints de identidad del panel (contrato de I0.6). La sesión (`/auth/me`, logout y
// cambio de negocio) está en app/session.tsx.

export const login = (input: LoginInput) => api.post<LoginResult>("/auth/login", input);

export const forgotPassword = (email: string) => api.post<void>("/auth/password/forgot", { email });

export const resetPassword = (token: string, password: string) =>
  api.post<void>("/auth/password/reset", { token, password });

export const changePassword = (currentPassword: string, newPassword: string) =>
  api.post<void>("/auth/password/change", { currentPassword, newPassword });

export const getInvitation = (token: string) => api.get<Invitation>(`/auth/invitations/${encodeURIComponent(token)}`);

export const acceptInvitation = (token: string, name: string, password: string) =>
  api.post<Me>("/auth/invitations/accept", { token, name, password });

export const setupTotp = () => api.post<TotpSetup>("/auth/totp/setup");

export const enableTotp = (code: string) => api.post<void>("/auth/totp/enable", { code });

export const disableTotp = (password: string, code: string) => api.post<void>("/auth/totp/disable", { password, code });

/** Mínimo de la clave que el panel valida antes de mandar (el backend es la autoridad). */
export const MIN_PASSWORD_LENGTH = 8;
