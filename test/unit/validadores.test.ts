import assert from "node:assert/strict";
import { test } from "node:test";
import {
  limpiarLineas,
  MAX_KB_CARACTERES,
  validarBloqueos,
  validarColorHex,
  validarFaq,
  validarGoogleCalendarId,
  validarGooglePlaceId,
  validarHorario,
  validarLinkResenas,
  validarLogoUrl,
  validarNombrePlantillaMarketing,
  validarNombrePlantillaReapertura,
  validarNombrePlantillaRescate,
  validarRescateHoras,
  validarServicios,
  validarTamanoKb,
  validarTextoRescate,
} from "../../src/config/validadores";
import type { KnowledgeBase } from "../../src/types";

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

// Upsell inteligente al agendar (Carril D, 1.2): addonSugeridoId debe apuntar a OTRO
// servicio de la misma lista (no a sí mismo, no a uno inexistente).
test("validarServicios: acepta un add-on que apunta a otro servicio de la lista", () => {
  const r = validarServicios([
    { id: "pulido", nombre: "Pulido", duracionMin: 90, addonSugeridoId: "focos", addonPrecioPromo: 8000, addonActivo: true },
    { id: "focos", nombre: "Pulido de focos", duracionMin: 60 },
  ]);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.servicios[0].addonSugeridoId, "focos");
    assert.equal(r.servicios[0].addonPrecioPromo, 8000);
    assert.equal(r.servicios[0].addonActivo, true);
  }
});

test("validarServicios: rechaza un add-on que se sugiere a sí mismo", () => {
  const r = validarServicios([{ id: "pulido", nombre: "Pulido", duracionMin: 90, addonSugeridoId: "pulido" }]);
  assert.equal(r.ok, false);
});

test("validarServicios: rechaza un add-on que apunta a un servicio inexistente", () => {
  const r = validarServicios([{ id: "pulido", nombre: "Pulido", duracionMin: 90, addonSugeridoId: "no-existe" }]);
  assert.equal(r.ok, false);
});

test("validarServicios: un add-on sugerido más adelante en la lista es válido (segunda pasada)", () => {
  const r = validarServicios([
    { id: "lavado", nombre: "Lavado", duracionMin: 60, addonSugeridoId: "cera" },
    { id: "cera", nombre: "Encerado", duracionMin: 20 },
  ]);
  assert.equal(r.ok, true);
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

test("validarNombrePlantillaRescate: normaliza a minúsculas y valida formato", () => {
  assert.equal(validarNombrePlantillaRescate("Rescate_Cotiz"), "rescate_cotiz");
  assert.equal(validarNombrePlantillaRescate("rescate cotiz"), null);
  assert.equal(validarNombrePlantillaRescate(""), "");
});

test("validarRescateHoras: acepta enteros entre 1 y 72, rechaza el resto", () => {
  assert.equal(validarRescateHoras(3), 3);
  assert.equal(validarRescateHoras("6"), 6);
  assert.equal(validarRescateHoras(0), null);
  assert.equal(validarRescateHoras(73), null);
  assert.equal(validarRescateHoras(2.5), null);
});

test("validarTextoRescate: vacío es válido (default), largo excesivo rechaza", () => {
  assert.equal(validarTextoRescate(""), "");
  assert.equal(validarTextoRescate("  ¿Te guardo el espacio?  "), "¿Te guardo el espacio?");
  assert.equal(validarTextoRescate("x".repeat(301)), null);
});

test("validarColorHex: acepta hex válido y normaliza a minúsculas", () => {
  assert.equal(validarColorHex("#ABCDEF"), "#abcdef");
  assert.equal(validarColorHex("abcdef"), null);
  assert.equal(validarColorHex(""), "");
});

test("validarLogoUrl: exige https cuando no está vacío (revisión de seguridad 2026-10)", () => {
  assert.equal(validarLogoUrl(""), "");
  assert.equal(validarLogoUrl("https://cdn.example.com/logo.png"), "https://cdn.example.com/logo.png");
  assert.equal(validarLogoUrl("http://cdn.example.com/logo.png"), null, "http ya no: contenido mixto/MITM");
  assert.equal(validarLogoUrl("https://usuario:clave@cdn.example.com/logo.png"), null);
  assert.equal(validarLogoUrl("javascript:alert(1)"), null);
});

test("validarGooglePlaceId: vacío es válido, formato alfanumérico con _/- es válido", () => {
  assert.equal(validarGooglePlaceId(""), "");
  assert.equal(validarGooglePlaceId("ChIJN1t_tDeuEmsRUsoyG83frY4"), "ChIJN1t_tDeuEmsRUsoyG83frY4");
  assert.equal(validarGooglePlaceId("muy corto"), null); // tiene espacio y es menor a 10 chars
  assert.equal(validarGooglePlaceId("<script>x</script>"), null);
});

test("validarGoogleCalendarId: vacío es válido; exige forma de correo y rechaza 'primary'", () => {
  assert.equal(validarGoogleCalendarId(""), "");
  assert.equal(validarGoogleCalendarId("negocio@gmail.com"), "negocio@gmail.com");
  assert.equal(
    validarGoogleCalendarId("  c_abc123@group.calendar.google.com  "),
    "c_abc123@group.calendar.google.com",
  );
  // "primary" apuntaría al calendario de NUESTRA service account, el mismo para todos
  // los tenants: es justo la fuga entre negocios que BLOQ-05 elimina.
  assert.equal(validarGoogleCalendarId("primary"), null);
  assert.equal(validarGoogleCalendarId("no-es-un-correo"), null);
  assert.equal(validarGoogleCalendarId("a@b"), null); // sin TLD
});

// ─────────────────────────────────────────────────────────────────────────────
// Tope de tamaño de la KB (ALTO-16 / F13 — PLAN-ESCALA-MULTITENANT.md): sin este freno,
// un catálogo pegado entero puede meter ~17.000 tokens en CADA llamada al LLM (ver
// AUDIT.md § ALTO-16). Se prueba que una KB normal pasa y una gigante rebota con un
// mensaje que le diga al dueño cuánto ocupa y cuál es el límite.
// ─────────────────────────────────────────────────────────────────────────────

const kbVacia: KnowledgeBase = { faq: [], datos: [], politicas: [], secciones: [] };

test("validarTamanoKb: una KB normal (chica) pasa sin error", () => {
  const kb: KnowledgeBase = {
    faq: [{ pregunta: "¿Hacen lavado de motor?", respuesta: "Sí, tenemos ese servicio." }],
    datos: ["Abrimos de lunes a sábado", "Aceptamos SINPE y tarjeta"],
    politicas: ["No se devuelve el dinero tras iniciado el servicio"],
    secciones: [{ id: "precios", titulo: "Precios", items: ["Sedán ₡4.000", "SUV ₡6.000"] }],
  };
  assert.equal(validarTamanoKb(kb), null);
});

test("validarTamanoKb: una KB vacía pasa sin error", () => {
  assert.equal(validarTamanoKb(kbVacia), null);
});

test("validarTamanoKb: una KB gigante rebota con un mensaje que diga cuánto ocupa y el límite", () => {
  // Una sola sección con un ítem enorme, bien por encima de MAX_KB_CARACTERES.
  const itemGigante = "x".repeat(MAX_KB_CARACTERES + 500);
  const kb: KnowledgeBase = {
    ...kbVacia,
    secciones: [{ id: "catalogo", titulo: "Catálogo completo", items: [itemGigante] }],
  };
  const error = validarTamanoKb(kb);
  assert.notEqual(error, null);
  // El mensaje usa toLocaleString("es-CR") para ser legible al dueño del negocio —
  // en ese locale el separador de miles es un espacio ("12 000", no "12000"), así
  // que comparamos contra el MISMO formato que usa el código, no contra el número
  // plano (buscar "12000" nunca matchearía "12 000").
  assert.match(error!, new RegExp(MAX_KB_CARACTERES.toLocaleString("es-CR")));
  assert.match(error!, /caracteres/i);
});

test("validarTamanoKb: justo en el límite pasa; uno más allá del límite rebota", () => {
  const kbJusto: KnowledgeBase = { ...kbVacia, datos: ["x".repeat(MAX_KB_CARACTERES)] };
  assert.equal(validarTamanoKb(kbJusto), null);

  const kbUnoMas: KnowledgeBase = { ...kbVacia, datos: ["x".repeat(MAX_KB_CARACTERES + 1)] };
  assert.notEqual(validarTamanoKb(kbUnoMas), null);
});
