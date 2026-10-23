// API pública del módulo onboarding (I6): alta self-service con verificación del correo y
// la checklist de primeros pasos del Inicio. Está afuera del núcleo (compone business,
// team, scheduling y billing; WhatsApp le llega inyectado) y el núcleo no lo importa
// (test/architecture/moduleBoundaries.test.ts). Lo compone src/routes.ts.
export { onboardingRoutes, type OnboardingRouteDeps } from "./routes";
export { dismissChecklist, getOnboarding, ONBOARDING_STEPS } from "./checklist";
export type { ChecklistDeps, OnboardingStep, OnboardingView } from "./checklist";
export { FIRST_LOCATION_NAME, resendVerification, signup, SignupInput, signupOptions, verifySignup } from "./signup";
export type { SignupAccepted, SignupDeps, SignupInputValue } from "./signup";
export { checkEmailDomain, emailDomainOf } from "./emailDomain";
export type { EmailDomainOptions, EmailDomainProblem, EmailDomainResult, MailDnsResolver } from "./emailDomain";
export { _resetSignupLimitsForTests } from "./rateLimit";
