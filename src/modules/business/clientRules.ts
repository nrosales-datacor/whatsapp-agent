import { eq } from "drizzle-orm";
import { recordConfigChange } from "../../platform/audit/configHistory";
import { withTenant, type Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import type { Session } from "../../platform/http/routeTypes";
import { invalidateBusinessContext } from "./context";
import { businesses } from "./schema";
import type { ClientStatusRules } from "./settings";
import { clientStatusRulesOverrides, readClientStatusRules } from "./statusRules";

// ─────────────────────────────────────────────────────────────────────────────
// Configuración › Reglas de clientes (`GET/PUT /settings/client-rules`, rutas en
// ./clientSettingsRoutes.ts): las reglas efectivas del negocio y las de la plantilla de su
// rubro ("Restaurar las del rubro"). En la base se guarda solo lo que difiere de los
// defaults globales (./statusRules.ts); cada cambio deja su snapshot en config_history e
// invalida el caché del contexto (la lista de clientes lo ve al toque en este proceso).
// ─────────────────────────────────────────────────────────────────────────────

/** `GET /settings/client-rules`. */
export interface ClientRulesView {
  /** Reglas efectivas del negocio. */
  rules: ClientStatusRules;
  /** Las de la plantilla de su rubro (lo que ofrece "Restaurar las del rubro"). */
  industryDefaults: ClientStatusRules;
  industry: string;
}

/** Reglas de la plantilla del rubro (inyectado para no atar este archivo al loader de plantillas). */
export type IndustryRulesLookup = (industry: string) => Partial<ClientStatusRules>;

async function loadBusiness(db: Executor, businessId: string) {
  const [row] = await withTenant(db, businessId, (tx) => tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1));
  if (!row) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  return row;
}

export async function getClientRules(db: Executor, businessId: string, industryRules: IndustryRulesLookup): Promise<ClientRulesView> {
  const business = await loadBusiness(db, businessId);
  return {
    rules: readClientStatusRules(business.clientStatusRules),
    industryDefaults: readClientStatusRules(industryRules(business.industry)),
    industry: business.industry,
  };
}

/** Guarda las reglas (con su rastro en config_history) e invalida el caché del contexto. */
export async function updateClientRules(
  db: Executor,
  session: Pick<Session, "businessId" | "userId">,
  rules: ClientStatusRules,
  industryRules: IndustryRulesLookup,
): Promise<ClientRulesView> {
  const { businessId } = session;
  const overrides = clientStatusRulesOverrides(rules);
  await withTenant(db, businessId, async (tx) => {
    const [row] = await tx
      .update(businesses)
      .set({ clientStatusRules: overrides })
      .where(eq(businesses.id, businessId))
      .returning({ id: businesses.id });
    if (!row) throw new HttpError(404, "Negocio no encontrado.", "not_found");
    await recordConfigChange(tx, { businessId, entity: "client_status_rules", entityId: businessId, snapshot: rules, changedBy: session.userId });
  });
  invalidateBusinessContext(businessId);
  return getClientRules(db, businessId, industryRules);
}
