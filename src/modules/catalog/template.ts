import { withTenant, type Executor } from "../../platform/db/scope";
import type { TemplateCatalog } from "../business";
import { serviceCategories, services } from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo de una plantilla de rubro (src/modules/business/templates/*.json) → categorías
// y servicios del negocio. Es el `seedCatalog` de `ProvisioningSteps`: lo llama el alta
// del negocio (business) a través de la composición.
//
// Un precio de referencia null queda en 0 ("sin precio": el panel lo muestra así y el
// negocio lo carga después). Los servicios se ofrecen en todas las sucursales y los hace
// cualquier profesional (sin filas en service_locations ni staff_services).
// ─────────────────────────────────────────────────────────────────────────────

export interface AppliedCatalog {
  categories: number;
  services: number;
}

export async function applyCatalogTemplate(
  executor: Executor,
  input: { businessId: string; catalog: TemplateCatalog },
): Promise<AppliedCatalog> {
  const { businessId, catalog } = input;
  return withTenant(executor, businessId, async (tx) => {
    let serviceCount = 0;
    for (const [position, category] of catalog.categories.entries()) {
      const [row] = await tx
        .insert(serviceCategories)
        .values({ businessId, name: category.name, position })
        .returning({ id: serviceCategories.id });
      await tx.insert(services).values(
        category.services.map((s, servicePosition) => ({
          businessId,
          categoryId: row.id,
          name: s.name,
          description: s.description ?? null,
          durationMin: s.durationMin,
          bufferMin: s.bufferMin,
          priceCents: s.priceCents ?? 0,
          variablePrice: s.variablePrice,
          onlineBooking: s.onlineBooking,
          position: servicePosition,
        })),
      );
      serviceCount += category.services.length;
    }
    return { categories: catalog.categories.length, services: serviceCount };
  });
}
