import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePhone, phoneDigits } from "../../src/modules/clients/phone";

// ─────────────────────────────────────────────────────────────────────────────
// Teléfonos de clientes a E.164 (src/modules/clients/phone.ts): la misma persona escrita
// de cualquier forma termina en el MISMO valor, que es lo que hace único el teléfono por
// negocio y deja al agente de WhatsApp encontrar al cliente.
// ─────────────────────────────────────────────────────────────────────────────

test("teléfono: un número local toma el país del negocio (Costa Rica por defecto)", () => {
  for (const input of ["88887777", "8888 7777", "8888-7777", "(8888) 7777", " 8888.7777 "]) {
    assert.equal(normalizePhone(input), "+50688887777", input);
    assert.equal(normalizePhone(input, "CR"), "+50688887777", input);
  }
  assert.equal(normalizePhone("2222-3333", "cr"), "+50622223333", "fijo de CR, país en minúscula");
  assert.equal(normalizePhone("6123-4567", "PA"), "+50761234567", "Panamá, 8 dígitos");
  assert.equal(normalizePhone("223-4567", "PA"), "+5072234567", "Panamá, fijo de 7 dígitos");
  assert.equal(normalizePhone("55 1234 5678", "MX"), "+525512345678");
  assert.equal(normalizePhone("(305) 555-0100", "US"), "+13055550100");
  assert.equal(normalizePhone("612 34 56 78", "ES"), "+34612345678");
});

test("teléfono: forma internacional con +, con 00 o con el código de país sin + (WhatsApp)", () => {
  assert.equal(normalizePhone("+506 8888 7777", "CR"), "+50688887777");
  assert.equal(normalizePhone("+506 8888 7777", "MX"), "+50688887777", "con + no importa el país del negocio");
  assert.equal(normalizePhone("00506 8888 7777", "CR"), "+50688887777");
  assert.equal(normalizePhone("50688887777", "CR"), "+50688887777", "así llegan los números de WhatsApp");
  assert.equal(normalizePhone("+1 305 555 0100", "CR"), "+13055550100");
  assert.equal(normalizePhone("+44 20 7946 0958", "CR"), "+442079460958", "país fuera de la tabla: regla general de E.164");
  assert.equal(normalizePhone("+5215512345678", "CR"), "+5215512345678", "MX con el 1 de móvil que manda WhatsApp");
  assert.equal(normalizePhone("+50600000001", "CR"), "+50600000001", "los números de prueba del seed (prefijo 0) pasan");
});

test("teléfono: prefijo troncal 0 en los países que lo usan", () => {
  assert.equal(normalizePhone("0991234567", "EC"), "+593991234567");
  assert.equal(normalizePhone("011 2345 6789", "AR"), "+541123456789");
  assert.equal(normalizePhone("099 123 456", "UY"), "+59899123456");
});

test("teléfono: lo que no es un teléfono válido devuelve null", () => {
  const invalid: Array<[string, string?]> = [
    [""],
    ["   "],
    ["8888777", "CR"], // 7 dígitos en CR
    ["888877771", "CR"], // 9 dígitos en CR
    ["+506 8888 777"], // CR con 7 dígitos, en forma internacional
    ["+0 123 4567"], // E.164 no empieza en 0
    ["+1234"], // muy corto
    ["+1234567890123456"], // más de 15 dígitos
    ["8888-7777 ext 2"], // letras
    ["abc"],
    ["+506 8888 7777; DROP TABLE"],
    ["88887777", "ZZ"], // país sin plan: un número local es ambiguo
    ["12345", "US"],
  ];
  for (const [input, country] of invalid) assert.equal(normalizePhone(input, country), null, `${JSON.stringify(input)} (${country ?? "CR"})`);
  // Con + sí sirve aunque el país del negocio no tenga plan.
  assert.equal(normalizePhone("+50688887777", "ZZ"), "+50688887777");
});

test("teléfono: todo lo normalizado cumple el CHECK de la base", () => {
  const check = /^\+[1-9][0-9]{6,14}$/;
  for (const input of ["88887777", "+13055550100", "50688887777", "0991234567", "+442079460958"]) {
    const out = normalizePhone(input, input.startsWith("0") ? "EC" : "CR");
    assert.ok(out && check.test(out), `${input} → ${out}`);
  }
});

test("teléfono: dígitos para el buscador", () => {
  assert.equal(phoneDigits("+506 8888-77"), "506888877");
  assert.equal(phoneDigits("María"), "");
});
