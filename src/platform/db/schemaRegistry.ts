import * as platform from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Registro de esquemas: junta las tablas de la plataforma y de TODOS los módulos en el
// objeto que recibe el cliente de Drizzle (./client.ts), para que las consultas
// relacionales (`db.query.*`) y los tipos las conozcan.
//
// Es el ÚNICO archivo de src/platform que importa de src/modules: cada módulo que nace
// con tablas suma acá su `schema.ts`:
//
//   import * as scheduling from "../../modules/scheduling/schema";
//   export const schema = { ...platform, ...scheduling };
//
// drizzle-kit no lee este archivo: toma los esquemas por glob (drizzle.config.ts).
// test/security/rls.test.ts verifica que toda tabla de un src/**/schema.ts esté acá.
// ─────────────────────────────────────────────────────────────────────────────

export const schema = { ...platform };

export type Schema = typeof schema;
