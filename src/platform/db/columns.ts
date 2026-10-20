import { sql, type SQL } from "drizzle-orm";
import { timestamp, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// Piezas comunes de los esquemas (plataforma y módulos), para que todas las tablas sigan
// las mismas convenciones de PLAN-GESTION.md §4 sin repetirlas a mano:
//   • `id` uuid con default aleatorio de Postgres (gen_random_uuid(), sin extensión).
//   • `created_at` / `updated_at` timestamptz; `updated_at` lo renueva Drizzle en cada
//     UPDATE hecho con el ORM (`$onUpdate`). Un UPDATE en SQL crudo tiene que fijarlo él.
//   • Enums como `text` + CHECK (`oneOf`): cambiar la lista es una migración chica y
//     legible, sin los ALTER TYPE de los enums nativos de Postgres.
// ─────────────────────────────────────────────────────────────────────────────

/** `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`. */
export const uuidPk = () => uuid("id").primaryKey().defaultRandom();

/** `created_at timestamptz NOT NULL DEFAULT now()`. */
export const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** `updated_at timestamptz NOT NULL DEFAULT now()`, renovado por Drizzle en cada UPDATE. */
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Las dos marcas de tiempo estándar, para desparramar en la definición de la tabla. */
export const timestamps = () => ({ createdAt: createdAt(), updatedAt: updatedAt() });

/** Instante con zona (`timestamptz`), con modo Date. */
export const instant = (name: string) => timestamp(name, { withTimezone: true });

// Los valores de un enum van como literales dentro del CHECK. Son constantes del código
// (nunca entrada de usuario), pero se valida la forma igual: un valor raro rompería la
// migración o, peor, el SQL del CHECK.
const ENUM_VALUE = /^[a-z][a-z0-9_]*$/;

/**
 * Condición de un CHECK de enum: `columna IN ('a', 'b', …)`. Para columnas nullable el
 * CHECK deja pasar NULL (así funciona SQL: la condición da NULL, no false).
 */
export function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  if (values.length === 0) throw new Error("oneOf: lista de valores vacía");
  for (const v of values) {
    if (!ENUM_VALUE.test(v)) throw new Error(`oneOf: valor de enum inválido "${v}"`);
  }
  return sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;
}
