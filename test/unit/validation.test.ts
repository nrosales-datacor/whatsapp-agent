import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { ValidationError } from "../../src/platform/http/errors";
import { parseOrThrow, spanishErrorMap, validateInput, zodFieldErrors } from "../../src/platform/http/validation";

// ─────────────────────────────────────────────────────────────────────────────
// Mensajes de validación en español (los que el panel muestra junto a cada campo) y la
// forma de `fields` en el 400.
// ─────────────────────────────────────────────────────────────────────────────

/** Primer mensaje de error de `schema` para `input`, con el mapa en español. */
function messageFor(schema: z.ZodType, input: unknown): string {
  const result = schema.safeParse(input, { error: spanishErrorMap });
  assert.equal(result.success, false, "se esperaba que fallara la validación");
  return result.error!.issues[0].message;
}

test("tipos y campos obligatorios", () => {
  assert.equal(messageFor(z.string(), undefined), "Campo obligatorio.");
  assert.equal(messageFor(z.string(), null), "Campo obligatorio.");
  assert.equal(messageFor(z.string(), 5), "Se esperaba un texto.");
  assert.equal(messageFor(z.number(), "5"), "Se esperaba un número.");
  assert.equal(messageFor(z.boolean(), "sí"), "Se esperaba verdadero o falso.");
  assert.equal(messageFor(z.array(z.string()), {}), "Se esperaba una lista.");
});

test("largos, rangos y cantidades", () => {
  assert.equal(messageFor(z.string().min(1), ""), "No puede quedar vacío.");
  assert.equal(messageFor(z.string().min(3), "ab"), "Debe tener al menos 3 caracteres.");
  assert.equal(messageFor(z.string().max(1), "ab"), "Debe tener como máximo 1 carácter.");
  assert.equal(messageFor(z.string().length(4), "abc"), "Debe tener exactamente 4 caracteres.");
  assert.equal(messageFor(z.number().min(0), -1), "Debe ser mayor o igual a 0.");
  assert.equal(messageFor(z.number().positive(), 0), "Debe ser mayor que 0.");
  assert.equal(messageFor(z.number().max(100), 101), "Debe ser menor o igual a 100.");
  assert.equal(messageFor(z.number().int(), 1.5), "Se esperaba un número entero.");
  assert.equal(messageFor(z.array(z.string()).min(1), []), "Debe tener al menos 1 elemento.");
  assert.equal(messageFor(z.number().multipleOf(5), 7), "Debe ser múltiplo de 5.");
});

test("formatos, opciones y campos de más", () => {
  assert.equal(messageFor(z.email(), "no-es-correo"), "Correo electrónico inválido.");
  assert.equal(messageFor(z.uuid(), "123"), "Identificador inválido.");
  assert.equal(messageFor(z.iso.date(), "2026-13-01"), "Fecha inválida (formato AAAA-MM-DD).");
  assert.equal(messageFor(z.string().regex(/^\d+$/), "abc"), "Formato inválido.");
  assert.equal(messageFor(z.enum(["cash", "card"]), "btc"), 'Debe ser uno de: "cash", "card".');
  assert.equal(messageFor(z.literal("yes"), "no"), 'Debe ser "yes".');
  assert.equal(messageFor(z.strictObject({ a: z.string() }), { a: "x", b: 1, c: 2 }), "Campos no permitidos: b, c.");
});

test("un mensaje propio del esquema gana al mapa en español", () => {
  assert.equal(messageFor(z.string().min(1, "El nombre es obligatorio."), ""), "El nombre es obligatorio.");
});

test("zodFieldErrors: clave = fuente + ruta; un error en la raíz queda con la fuente; gana el primero", () => {
  const schema = z.object({
    name: z.string().min(2),
    items: z.array(z.object({ price: z.number() })),
  });
  const result = schema.safeParse({ name: "a", items: [{ price: 1 }, { price: "x" }] }, { error: spanishErrorMap });
  assert.equal(result.success, false);
  assert.deepEqual(zodFieldErrors(result.error!, "body"), {
    "body.name": "Debe tener al menos 2 caracteres.",
    "body.items.1.price": "Se esperaba un número.",
  });

  const root = z.object({}).safeParse("texto", { error: spanishErrorMap });
  assert.deepEqual(zodFieldErrors(root.error!, "body"), { body: "Se esperaba un objeto." });

  const twice = z.string().min(5).regex(/^\d+$/).safeParse("ab", { error: spanishErrorMap });
  assert.equal(twice.error!.issues.length, 2);
  assert.deepEqual(zodFieldErrors(twice.error!, "query"), { query: "Debe tener al menos 5 caracteres." });
});

test("validateInput no lanza; parseOrThrow lanza ValidationError (400 con fields)", async () => {
  const schema = z.object({ page: z.coerce.number().int().min(1) });
  assert.deepEqual(await validateInput(schema, { page: "3" }, "query"), { ok: true, data: { page: 3 } });
  assert.deepEqual(await validateInput(schema, { page: "0" }, "query"), {
    ok: false,
    fields: { "query.page": "Debe ser mayor o igual a 1." },
  });

  await assert.rejects(
    () => parseOrThrow(schema, { page: "x" }),
    (e: unknown) => {
      assert.ok(e instanceof ValidationError);
      assert.equal(e.status, 400);
      assert.equal(e.code, "validation_error");
      assert.deepEqual(e.fields, { "body.page": "Se esperaba un número." });
      return true;
    },
  );
});
