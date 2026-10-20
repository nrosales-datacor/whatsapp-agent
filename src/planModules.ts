import type { ModuleGate } from "./platform/http/routeTypes";

// ─────────────────────────────────────────────────────────────────────────────
// Módulos del plan (PLAN-GESTION.md §5), PROVISIONAL hasta I2.
//
// TODO(I2): leer el plan del negocio (`businesses.plan` + `extra_modules`) desde
// `modules/billing` y devolver solo lo que incluye. Hasta entonces todo negocio tiene
// todos los módulos: `moduleGate` deja pasar todo y `enabledModules` devuelve la lista
// completa (es lo que el panel recibe en `me.modules`).
//
// Vive en la composición (src/, junto a routes.ts) y no en un módulo del núcleo: el
// núcleo no puede importar `billing` (test/architecture/moduleBoundaries.test.ts), así
// que se le inyecta.
// ─────────────────────────────────────────────────────────────────────────────

/** Todos los módulos que una ruta puede declarar en `module` (y que el panel muestra u oculta). */
export const ALL_MODULES = ["scheduling", "clients", "sales", "commissions", "reports", "whatsapp", "campaigns"] as const;
export type ModuleName = (typeof ALL_MODULES)[number];

/** ¿El plan del negocio incluye el módulo? Provisional: sí, si el módulo existe. */
export const moduleGate: ModuleGate = (_businessId, module) => (ALL_MODULES as readonly string[]).includes(module);

/** Módulos habilitados del negocio. Provisional: todos. */
export function enabledModules(_businessId: string): readonly string[] {
  return ALL_MODULES;
}
