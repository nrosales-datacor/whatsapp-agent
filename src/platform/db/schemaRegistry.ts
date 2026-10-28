import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as billing from "../../modules/billing/schema";
import * as business from "../../modules/business/schema";
import * as campaigns from "../../modules/campaigns/schema";
import * as catalog from "../../modules/catalog/schema";
import * as clients from "../../modules/clients/schema";
import * as commissions from "../../modules/commissions/schema";
import * as sales from "../../modules/sales/schema";
import * as scheduling from "../../modules/scheduling/schema";
import * as team from "../../modules/team/schema";
import * as whatsapp from "../../modules/whatsapp/schema";
import * as queue from "../queue/schema";
import * as platform from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Registro de esquemas: junta las tablas de la plataforma y de TODOS los módulos en el
// objeto que recibe el cliente de Drizzle (./client.ts), para que las consultas
// relacionales (`db.query.*`) y los tipos las conozcan.
//
// Es el ÚNICO archivo de src/platform que importa de src/modules: cada módulo que nace
// con tablas suma acá su `schema.ts` (import + una entrada en `schema`).
//
// Solo entran las TABLAS (`tablesOf`): los schema.ts también exportan las listas de
// valores de sus enums y tipos, que no son parte del esquema de Drizzle y podrían chocar
// de nombre entre módulos.
//
// drizzle-kit no lee este archivo: toma los esquemas por glob (drizzle.config.ts).
// test/security/rls.test.ts verifica que toda tabla de un src/**/schema.ts esté acá.
// ─────────────────────────────────────────────────────────────────────────────

/** Las claves de `T` cuyo valor es una tabla. */
type TableKeys<T> = { [K in keyof T]: T[K] extends PgTable ? K : never }[keyof T];

/** Solo las tablas de un módulo de esquema. */
function tablesOf<T extends Record<string, unknown>>(mod: T): Pick<T, TableKeys<T>> {
  return Object.fromEntries(Object.entries(mod).filter(([, v]) => is(v, PgTable))) as Pick<T, TableKeys<T>>;
}

export const schema = {
  ...tablesOf(platform),
  ...tablesOf(queue),
  ...tablesOf(business),
  ...tablesOf(team),
  ...tablesOf(catalog),
  ...tablesOf(clients),
  ...tablesOf(scheduling),
  ...tablesOf(sales),
  ...tablesOf(commissions),
  ...tablesOf(whatsapp),
  ...tablesOf(campaigns),
  ...tablesOf(billing),
};

export type Schema = typeof schema;
