import type { ProvisioningSteps } from "./modules/business";
import { applyCatalogTemplate } from "./modules/catalog";
import { seedDefaultPaymentMethods } from "./modules/sales";

// ─────────────────────────────────────────────────────────────────────────────
// Composición del alta de un negocio: los pasos que viven en otros módulos y que
// `createBusiness` (modules/business) recibe inyectados, porque business no puede
// importar a catalog ni a sales (ellos dependen de business). Lo usan el alta del
// superadmin (src/admin/routes.ts) y quien quiera crear un negocio completo.
//
//   • seedCatalog: categorías y servicios de ejemplo de la plantilla del rubro.
//   • seedPaymentMethods: efectivo, SINPE Móvil, tarjeta y transferencia.
// ─────────────────────────────────────────────────────────────────────────────

export const PROVISIONING_STEPS: ProvisioningSteps = Object.freeze({
  seedCatalog: applyCatalogTemplate,
  seedPaymentMethods: seedDefaultPaymentMethods,
});
