import assert from "node:assert/strict";
import { test } from "node:test";
import {
  limpiarLineas,
  validarBloqueos,
  validarColorHex,
  validarFaq,
  validarHorario,
  validarLinkResenas,
  validarLogoUrl,
  validarNombrePlantillaMarketing,
  validarNombrePlantillaReapertura,
  validarServicios,
} from "../../src/config/validadores";

test("limpiarLineas: descarta vacíos y recorta espacios", () => {
  assert.deepEqual(limpiarLineas([" hola ", "", "  ", "mundo"]), ["hola", "mundo"]);
  assert.deepEqual(limpiarLineas("no es arreglo"), []);
});

test("validarHorario: acepta horas válidas y completa días faltantes con default", () => {
  const out = validarHorario({ 1: { abre: "07:00", cierra: "17:00" } });
  assert.deepEqual(out?.[1], { abre: "07:00", cierra: "17:00" });
  assert.deepEqual(out?.[2], { abre: "06:00", cierra: "18:00" }); // default razonable
});

test("validarHorario: día cerrado (abre y cierra null) es válido", () => {
  const out = validarHorario({ 0: { abre: null, cierra: null } });
  assert.deepEqual(out?.[0], { abre: null, cierra: null });
});

test("validarHorario: hora con formato inválido rechaza todo", () => {
  assert.equal(validarHorario({ 1: { abre: "7:00", cierra: "17:00" } }), null);
  assert.equal(validarHorario({ 1: { abre: "25:00", cierra: "17:00" } }), null);
});

test("validarServicios: acepta un servicio válido con precio", () => {
  const r = validarServicios([{ id: "lavado-basico", nombre: "Lavado básico", duracionMin: 30, precio: 5000 }]);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.servicios[0].id, "lavado-basico");
});

test("validarServicios: rechaza id con mayúsculas o espacios", () => {
  const r = validarServicios([{ id: "Lavado Basico", nombre: "x", duracionMin: 30 }]);
  assert.equal(r.ok, false);
});

test("validarServicios: rechaza id repetido", () => {
  const r = validarServicios([
    { id: "a", nombre: "A", duracionMin: 30 },
    { id: "a", nombre: "B", duracionMin: 30 },
  ]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /repetido/);
});

test("validarServicios: rechaza duración fuera de rango", () => {
  const r = validarServicios([{ id: "a", nombre: "A", duracionMin: 0 }]);
  assert.equal(r.ok, false);
});

test("validarServicios: rechaza precio negativo o no entero", () => {
  const r = validarServicios([{ id: "a", nombre: "A", duracionMin: 30, precio: -5 }]);
  assert.equal(r.ok, false);
});

test("validarFaq: descarta entradas incompletas", () => {
  const out = validarFaq([
    { pregunta: "¿Abren domingo?", respuesta: "No" },
    { pregunta: "", respuesta: "vacía" },
  ]);
  assert.equal(out.length, 1);
});

test("validarBloqueos: acepta rango válido, rechaza desde > hasta", () => {
  assert.deepEqual(validarBloqueos([{ desde: "2026-12-24", hasta: "2026-12-26" }]), [
    { desde: "2026-12-24", hasta: "2026-12-26" },
  ]);
  assert.equal(validarBloqueos([{ desde: "2026-12-26", hasta: "2026-12-24" }]), null);
});

test("validarBloqueos: rechaza más de 50 bloqueos", () => {
  const muchos = Array.from({ length: 51 }, () => ({ desde: "2026-01-01", hasta: "2026-01-02" }));
  assert.equal(validarBloqueos(muchos), null);
});

test("validarLinkResenas: vacío es válido, URL sin http(s) es inválida", () => {
  assert.equal(validarLinkResenas(""), "");
  assert.equal(validarLinkResenas("https://g.page/r/xyz"), "https://g.page/r/xyz");
  assert.equal(validarLinkResenas("ftp://algo"), null);
});

test("validarNombrePlantillaMarketing: normaliza a minúsculas y valida formato", () => {
  assert.equal(validarNombrePlantillaMarketing("Promo_Verano"), "promo_verano");
  assert.equal(validarNombrePlantillaMarketing("promo verano"), null);
  assert.equal(validarNombrePlantillaMarketing(""), "");
});

test("validarNombrePlantillaReapertura: normaliza a minúsculas y valida formato", () => {
  assert.equal(validarNombrePlantillaReapertura("Reapertura_Conv"), "reapertura_conv");
  assert.equal(validarNombrePlantillaReapertura("reapertura conv"), null);
  assert.equal(validarNombrePlantillaReapertura(""), "");
});

test("validarColorHex: acepta hex válido y normaliza a minúsculas", () => {
  assert.equal(validarColorHex("#ABCDEF"), "#abcdef");
  assert.equal(validarColorHex("abcdef"), null);
  assert.equal(validarColorHex(""), "");
});

test("validarLogoUrl: exige http(s) cuando no está vacío", () => {
  assert.equal(validarLogoUrl(""), "");
  assert.equal(validarLogoUrl("http://cdn.example.com/logo.png"), "http://cdn.example.com/logo.png");
  assert.equal(validarLogoUrl("javascript:alert(1)"), null);
});
