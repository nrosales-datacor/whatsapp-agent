import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LEGAL_VERSION } from "../../src/platform/legal";

// ─────────────────────────────────────────────────────────────────────────────
// Documentos legales de landing/ (Carril P, "privacidad y términos"):
//
//   • Cada uno muestra la versión vigente (`data-legal-version` = LEGAL_VERSION): si se
//     cambia el texto y se sube la versión, o al revés, este test lo marca.
//   • Marcadores: en privacidad y términos el ÚNICO formato de dato faltante es
//     `[PENDIENTE: …]` (nada de corchetes sueltos tipo "[RAZÓN SOCIAL]"); el contrato suma
//     los campos de cada negocio, `[CLIENTE: …]` y `[FIRMA: …]`. Cada marcador del texto
//     está en la lista del comentario de cabecera (así el reporte de pendientes no miente).
//   • Versión final: sin el aviso de borrador NO puede quedar ningún `[PENDIENTE: …]` (en
//     privacidad y términos, ningún corchete). Quitar el aviso = completar todos los datos.
//   • Cubren el producto de hoy: CRM, ventas, personal, sucursales, Stripe, el proveedor
//     de correo, cookies de sesión, el SDK de Meta; y no publican el WhatsApp personal del
//     piloto como canal legal.
// ─────────────────────────────────────────────────────────────────────────────

const LANDING = fileURLToPath(new URL("../../landing/", import.meta.url));
const read = (name: string) => readFileSync(`${LANDING}${name}`, "utf8");

const DOCS = ["privacidad.html", "terminos.html", "contrato.html"] as const;
/** Formatos de marcador permitidos por documento. */
const ALLOWED: Record<(typeof DOCS)[number], RegExp> = {
  "privacidad.html": /^\[PENDIENTE: [^\]]+\]$/,
  "terminos.html": /^\[PENDIENTE: [^\]]+\]$/,
  "contrato.html": /^\[(PENDIENTE|CLIENTE|FIRMA): [^\]]+\]$/,
};
/** El ejemplo del aviso de borrador ("los datos marcados como [PENDIENTE: …]"). */
const EXAMPLE = /^\[(PENDIENTE|CLIENTE): …\]$/;

const withoutComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "");
const headerComment = (html: string) => /<!--([\s\S]*?)-->/.exec(html.slice(html.indexOf("</header>")))?.[1] ?? "";
const brackets = (html: string) => [...withoutComments(html).matchAll(/\[[^\]<>]*\]/g)].map((m) => m[0]);
/** Nombre del marcador sin la explicación: "[PENDIENTE: retención … — propuesta…]" → "[PENDIENTE: retención …]". */
const markerName = (marker: string) => marker.replace(/\s+—[\s\S]*\]$/, "]").replace(/\s+/g, " ");
const isDraft = (html: string) => /class="aviso-borrador"/.test(html);

for (const doc of DOCS) {
  test(`${doc}: muestra la versión legal vigente`, () => {
    const html = read(doc);
    assert.ok(html.includes(`data-legal-version="${LEGAL_VERSION}"`), `falta data-legal-version="${LEGAL_VERSION}" (src/platform/legal.ts)`);
    assert.equal(html.match(/data-legal-version="/g)?.length, 1, "una sola marca de versión");
  });

  test(`${doc}: los datos faltantes solo como marcador visible, todos listados en la cabecera`, () => {
    const html = read(doc);
    const found = brackets(html);
    for (const b of found) assert.match(b, ALLOWED[doc], `corchete con otro formato en ${doc}: ${b}`);

    const listed = headerComment(html);
    const pending = [...new Set(found.filter((b) => b.startsWith("[PENDIENTE:") && !EXAMPLE.test(b)).map(markerName))];
    for (const marker of pending) {
      assert.ok(listed.includes(marker), `${doc}: ${marker} no está en la lista de pendientes del comentario de cabecera`);
    }
    // Y la lista no tiene marcadores que ya no están en el texto.
    const listedMarkers = [...new Set([...listed.matchAll(/\[PENDIENTE: [^\]]+\]/g)].map((m) => m[0]))].filter((m) => !EXAMPLE.test(m));
    for (const marker of listedMarkers) {
      assert.ok(pending.includes(marker), `${doc}: la cabecera lista ${marker}, que ya no está en el texto`);
    }
  });

  test(`${doc}: sin el aviso de borrador no queda ningún pendiente`, () => {
    const html = read(doc);
    const pending = brackets(html).filter((b) => b.startsWith("[PENDIENTE:"));
    if (!isDraft(html)) {
      assert.deepEqual(pending, [], `${doc} ya no dice "borrador" pero le faltan datos`);
      if (doc !== "contrato.html") assert.deepEqual(brackets(html), [], `${doc}: ningún corchete en la versión final`);
    } else {
      assert.match(html, /Borrador sin revisión legal/, "el aviso dice que no tiene revisión legal");
    }
  });

  test(`${doc}: no publica el WhatsApp personal del piloto como canal legal`, () => {
    const html = read(doc);
    assert.doesNotMatch(html, /50683658231|8365\s?8231/);
    assert.doesNotMatch(html, /wa\.me\//);
  });
}

test("privacidad: describe el producto de hoy (CRM, ventas, personal, sucursales, Stripe, correo, cookies, SDK de Meta)", () => {
  const text = withoutComments(read("privacidad.html"));
  for (const needle of [
    "CRM",
    "Ventas y pagos",
    "comisiones",
    "sucursal",
    "Stripe",
    "Resend",
    "correo",
    "Cookies",
    "panel_session",
    "estrictamente necesario",
    "connect.facebook.net",
    "registro automático de eventos apagado",
    "OpenAI",
    "PRODHAB",
    "BAJA",
  ]) {
    assert.ok(text.includes(needle), `privacidad.html no menciona "${needle}"`);
  }
  assert.doesNotMatch(text, /lavacar|placa del vehículo|Recepcionista IA”/i, "nada del producto anterior en el texto legal");
});

test("términos: cubren el panel (CRM, prueba gratis, Stripe, equipo invitado, cookies de sesión) y la aceptación versionada", () => {
  const text = withoutComments(read("terminos.html"));
  for (const needle of ["CRM", "Prueba gratis", "Stripe", "invitación", "panel_session", "correo", "versión", "sucursal", "/privacidad"]) {
    assert.ok(text.includes(needle), `terminos.html no menciona "${needle}"`);
  }
  assert.doesNotMatch(text, /“Recepcionista IA”/, "ya no define el producto como Recepcionista IA");
});

test("contrato: subencargados al día (Stripe y el proveedor de correo) y firma antes de conectar el número", () => {
  const text = withoutComments(read("contrato.html"));
  for (const needle of ["Stripe", "Resend", "Selyon CRM", "Antes de conectar el número", "Pro sin agente"]) {
    assert.ok(text.includes(needle), `contrato.html no menciona "${needle}"`);
  }
});
