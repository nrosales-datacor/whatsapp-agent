import { z } from "zod";
import { ValidationError } from "./errors";

// ─────────────────────────────────────────────────────────────────────────────
// Validación con Zod para la API del panel: mensajes en español y errores por campo.
//
// El mapa de errores se pasa en CADA parse (no se toca la config global de Zod): un
// esquema con mensaje propio (`z.string().min(1, "El nombre es obligatorio")`) sigue
// ganando, y lo que este mapa no cubre cae al locale `es` de Zod.
// ─────────────────────────────────────────────────────────────────────────────

const zodSpanish = z.locales.es().localeError;

const TYPE_NAMES: Record<string, string> = {
  string: "un texto",
  number: "un número",
  int: "un número entero",
  boolean: "verdadero o falso",
  bigint: "un número entero",
  date: "una fecha",
  array: "una lista",
  object: "un objeto",
  null: "nulo",
};

const FORMAT_MESSAGES: Record<string, string> = {
  email: "Correo electrónico inválido.",
  url: "URL inválida.",
  uuid: "Identificador inválido.",
  uuidv4: "Identificador inválido.",
  uuidv6: "Identificador inválido.",
  uuidv7: "Identificador inválido.",
  guid: "Identificador inválido.",
  date: "Fecha inválida (formato AAAA-MM-DD).",
  datetime: "Fecha y hora inválidas.",
  time: "Hora inválida (formato HH:MM).",
  e164: "Número de teléfono inválido.",
};

function plural(n: number | bigint, singular: string, pluralForm: string): string {
  return Number(n) === 1 ? singular : pluralForm;
}

/** Mapa de errores de Zod en español (es-CR) para mostrar junto a cada campo del panel. */
export const spanishErrorMap: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case "invalid_type":
      if (issue.input === undefined || issue.input === null) return "Campo obligatorio.";
      return `Se esperaba ${TYPE_NAMES[issue.expected] ?? "otro tipo de dato"}.`;

    case "too_small": {
      const n = issue.minimum;
      if (issue.origin === "string") {
        if (issue.exact) return `Debe tener exactamente ${n} ${plural(n, "carácter", "caracteres")}.`;
        if (Number(n) === 1) return "No puede quedar vacío.";
        return `Debe tener al menos ${n} ${plural(n, "carácter", "caracteres")}.`;
      }
      if (issue.origin === "array" || issue.origin === "set") {
        if (issue.exact) return `Debe tener exactamente ${n} ${plural(n, "elemento", "elementos")}.`;
        return `Debe tener al menos ${n} ${plural(n, "elemento", "elementos")}.`;
      }
      if (issue.origin === "number" || issue.origin === "int" || issue.origin === "bigint") {
        return issue.inclusive ? `Debe ser mayor o igual a ${n}.` : `Debe ser mayor que ${n}.`;
      }
      return zodSpanish(issue);
    }

    case "too_big": {
      const n = issue.maximum;
      if (issue.origin === "string") {
        if (issue.exact) return `Debe tener exactamente ${n} ${plural(n, "carácter", "caracteres")}.`;
        return `Debe tener como máximo ${n} ${plural(n, "carácter", "caracteres")}.`;
      }
      if (issue.origin === "array" || issue.origin === "set") {
        if (issue.exact) return `Debe tener exactamente ${n} ${plural(n, "elemento", "elementos")}.`;
        return `Debe tener como máximo ${n} ${plural(n, "elemento", "elementos")}.`;
      }
      if (issue.origin === "number" || issue.origin === "int" || issue.origin === "bigint") {
        return issue.inclusive ? `Debe ser menor o igual a ${n}.` : `Debe ser menor que ${n}.`;
      }
      return zodSpanish(issue);
    }

    case "invalid_format":
      return FORMAT_MESSAGES[issue.format] ?? "Formato inválido.";

    case "invalid_value":
      if (issue.values.length === 1) return `Debe ser ${JSON.stringify(issue.values[0])}.`;
      return `Debe ser uno de: ${issue.values.map((v) => JSON.stringify(v)).join(", ")}.`;

    case "unrecognized_keys": {
      const many = issue.keys.length > 1;
      return `Campo${many ? "s" : ""} no permitido${many ? "s" : ""}: ${issue.keys.join(", ")}.`;
    }

    case "not_multiple_of":
      return `Debe ser múltiplo de ${issue.divisor}.`;

    default:
      return zodSpanish(issue);
  }
};

/** De dónde viene el dato validado; es el prefijo de las claves de `fields`. */
export type InputSource = "params" | "query" | "body";

/**
 * Errores de Zod → `{ "body.name": "Campo obligatorio." }`. Clave = fuente + ruta del
 * campo unidas con punto (un error sobre la raíz queda con la fuente sola: `"body"`).
 * Si un campo tiene varios errores, queda el primero.
 */
export function zodFieldErrors(error: z.core.$ZodError, source: InputSource): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = [source, ...issue.path.map((p) => String(p))].join(".");
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; fields: Record<string, string> };

/** Valida `input` contra `schema` con los mensajes en español. No lanza. */
export async function validateInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
  source: InputSource,
): Promise<ValidationResult<z.output<S>>> {
  const result = await schema.safeParseAsync(input, { error: spanishErrorMap });
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, fields: zodFieldErrors(result.error, source) };
}

/**
 * Igual que `validateInput` pero lanza `ValidationError` (400 con `fields`). Para
 * handlers que validan algo más allá de lo que declara la ruta.
 */
export async function parseOrThrow<S extends z.ZodType>(
  schema: S,
  input: unknown,
  source: InputSource = "body",
): Promise<z.output<S>> {
  const result = await validateInput(schema, input, source);
  if (!result.ok) throw new ValidationError(result.fields);
  return result.data;
}
