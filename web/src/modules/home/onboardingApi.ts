import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { OnboardingStatus } from "../../lib/contract";

// Primeros pasos del Inicio (I6, dueño y admin): GET /onboarding y POST /onboarding/dismiss.

export const ONBOARDING_QUERY_KEY = ["onboarding"] as const;

export const getOnboarding = () => api.get<OnboardingStatus>("/onboarding");

export const dismissOnboarding = () => api.post<OnboardingStatus>("/onboarding/dismiss");

export function useOnboarding(enabled: boolean) {
  // Sin caché: al volver al Inicio después de configurar algo, los pasos se recalculan.
  return useQuery({ queryKey: ONBOARDING_QUERY_KEY, queryFn: getOnboarding, enabled, staleTime: 0 });
}
