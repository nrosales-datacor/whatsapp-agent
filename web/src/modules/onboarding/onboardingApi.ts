import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { Me, OnboardingStatus, SignupInput, SignupOptions } from "../../lib/contract";

// Alta self-service y checklist de primeros pasos (I6). Las rutas de /signup son públicas.

export const getSignupOptions = () => api.get<SignupOptions>("/signup/options");

/** Siempre 202 "revisá tu correo" (exista o no el correo: no se revela). */
export const signup = (input: SignupInput) => api.post<{ status: "verification_sent" }>("/signup", input);

/** Verifica el correo con el token del enlace y deja la sesión iniciada. */
export const verifySignup = (token: string) => api.post<Me>("/signup/verify", { token });

/** Reenvía el enlace (204 siempre). */
export const resendVerification = (email: string) => api.post<void>("/signup/resend", { email });

export const ONBOARDING_QUERY_KEY = ["onboarding"] as const;

export const getOnboarding = () => api.get<OnboardingStatus>("/onboarding");

export const dismissOnboarding = () => api.post<OnboardingStatus>("/onboarding/dismiss");

export function useSignupOptions() {
  return useQuery({ queryKey: ["signup", "options"], queryFn: getSignupOptions, staleTime: 5 * 60_000 });
}

export function useOnboarding(enabled: boolean) {
  return useQuery({ queryKey: ONBOARDING_QUERY_KEY, queryFn: getOnboarding, enabled, staleTime: 15_000 });
}
