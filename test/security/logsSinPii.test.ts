import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { log } from "../../src/observabilidad/log";
import { describirTexto, enmascararTelefono } from "../../src/observabilidad/privacidad";

// ─────────────────────────────────────────────────────────────────────────────
// Datos personales en los logs (revisión pre-venta 2026-10, Ley 8968). Los logs
// llegaron a escribir el teléfono completo del cliente y hasta 80 caracteres de
// cada mensaje (entrante, transcripción de audio, respuesta del bot).
//
// Este test recorre TODO src/ y falla si un console.* / log.* interpola una variable
// con nombre de dato personal (clienteWa, texto, respuesta, contenido, transcripción)
// sin pasar por enmascararTelefono()/describirTexto() de src/observabilidad/privacidad.ts.
// `x.length` está permitido (es solo la longitud). Excepción explícita y revisable:
// un comentario `// log-pii-ok: motivo` en la línea de la llamada.
// ─────────────────────────────────────────────────────────────────────────────

const RAIZ_SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const HELPERS = ["enmascararTelefono", "describirTexto", "sanearCamposLog"];
const INICIO_LLAMADA = /(?<![\w$.])(?:console\.(?:log|warn|error|info|debug)|log\.(?:info|warn|error))\s*\(/g;

/** Identificadores que nombran un teléfono del cliente o el contenido de un mensaje. */
function esNombrePii(id: string): boolean {
  return (
    /^(clienteWa|texto|respuesta|contenido|transcripcion)/i.test(id) ||
    /(ClienteWa|Texto|Respuesta|Contenido|Transcrito|Transcripcion)$/.test(id)
  );
}

/**
 * Desde `inicio` (justo después del `(` de la llamada) devuelve el código de los
 * argumentos SIN el texto estático de los strings (sí con las expresiones `${…}` de
 * los template literals) y el índice donde cierra la llamada.
 */
function argumentosComoCodigo(fuente: string, inicio: number): { codigo: string; fin: number } {
  let codigo = "";
  let i = inicio;
  // Pila de contextos: "codigo" (con su profundidad de paréntesis/llaves) o "template".
  const pila: Array<{ tipo: "codigo"; prof: number } | { tipo: "template" }> = [{ tipo: "codigo", prof: 1 }];
  while (i < fuente.length) {
    const tope = pila[pila.length - 1];
    const c = fuente[i];
    if (tope.tipo === "template") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { pila.pop(); codigo += '""'; i++; continue; }
      if (c === "$" && fuente[i + 1] === "{") { pila.push({ tipo: "codigo", prof: 1 }); codigo += " ("; i += 2; continue; }
      i++;
      continue;
    }
    // Contexto de código.
    if (c === "/" && fuente[i + 1] === "/") { while (i < fuente.length && fuente[i] !== "\n") i++; continue; }
    if (c === "/" && fuente[i + 1] === "*") { i = fuente.indexOf("*/", i + 2) + 2; continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < fuente.length && fuente[i] !== c) i += fuente[i] === "\\" ? 2 : 1;
      i++;
      codigo += '""';
      continue;
    }
    if (c === "`") { pila.push({ tipo: "template" }); i++; continue; }
    if (c === "(" || c === "{" || c === "[") tope.prof++;
    if (c === ")" || c === "}" || c === "]") {
      tope.prof--;
      if (tope.prof === 0) {
        pila.pop();
        if (pila.length === 0) return { codigo, fin: i };
        codigo += ") "; // cierre de un `${…}`: vuelve al template
        i++;
        continue;
      }
    }
    codigo += c;
    i++;
  }
  return { codigo, fin: fuente.length };
}

/** Borra las llamadas a los helpers (con sus argumentos balanceados): lo que pasa por ellos está saneado. */
function sinHelpers(codigo: string): string {
  let salida = codigo;
  for (;;) {
    const m = new RegExp(`\\b(?:${HELPERS.join("|")})\\s*\\(`).exec(salida);
    if (!m) return salida;
    let i = m.index + m[0].length;
    let prof = 1;
    while (i < salida.length && prof > 0) {
      if (salida[i] === "(") prof++;
      else if (salida[i] === ")") prof--;
      i++;
    }
    salida = salida.slice(0, m.index) + "SANEADO" + salida.slice(i);
  }
}

/** Devuelve las violaciones de un archivo fuente: "linea: identificador". */
export function violacionesEnFuente(fuente: string): string[] {
  const violaciones: string[] = [];
  const lineas = fuente.split(/\r?\n/);
  for (const m of fuente.matchAll(INICIO_LLAMADA)) {
    const inicio = m.index! + m[0].length;
    const { codigo, fin } = argumentosComoCodigo(fuente, inicio);
    const lineaIni = fuente.slice(0, m.index).split("\n").length;
    const lineaFin = fuente.slice(0, fin).split("\n").length;
    const textoLineas = lineas.slice(lineaIni - 1, lineaFin).join("\n");
    if (textoLineas.includes("log-pii-ok:")) continue;
    const limpio = sinHelpers(codigo);
    for (const id of limpio.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*(?![\w$])(?!\s*\.\s*length\b)/g)) {
      if (esNombrePii(id[0])) violaciones.push(`${lineaIni}: ${id[0]}`);
    }
  }
  return violaciones;
}

function* archivosTs(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const ruta = path.join(dir, e.name);
    if (e.isDirectory()) yield* archivosTs(ruta);
    else if (/\.tsx?$/.test(e.name)) yield ruta;
  }
}

test("ningún console.*/log.* de src/ interpola teléfonos o contenido de mensajes sin el helper", () => {
  const todas: string[] = [];
  for (const archivo of archivosTs(RAIZ_SRC)) {
    const rel = path.relative(RAIZ_SRC, archivo).replace(/\\/g, "/");
    for (const v of violacionesEnFuente(readFileSync(archivo, "utf8"))) todas.push(`src/${rel}:${v}`);
  }
  assert.deepEqual(
    todas,
    [],
    "Logs con datos personales. Usá enmascararTelefono()/describirTexto() (src/observabilidad/privacidad.ts), " +
      "logueá solo `.length`, o marcá la línea con `// log-pii-ok: motivo` si de verdad no es un dato personal.",
  );
});

test("el detector caza los patrones viejos y deja pasar los saneados (autotest)", () => {
  const malos = [
    'console.log(`[entrante] ${entrante.clienteWa}: "${entrante.texto.slice(0, 80)}"`);',
    'console.log(`[saliente] → ${to}: "${respuesta.slice(0, 80)}"`);',
    'console.log(`[audio] ${x}: "${textoTranscrito.slice(0, 80)}"`);',
    'log.info("evento", { tenantId, cliente: conv.clienteWa });',
    'console.error("[x] falló para", cand.clienteWa, e);',
    "console.log(\n  `[panel] ${a}: \"${texto.slice(0, 60)}\"`,\n);",
  ];
  for (const fuente of malos) assert.notDeepEqual(violacionesEnFuente(fuente), [], `debió detectar: ${fuente}`);

  const buenos = [
    'console.log(`[entrante] ${enmascararTelefono(entrante.clienteWa)} ${describirTexto(entrante.texto)}`);',
    'log.info("entrante", { tenantId: t.id, largo: entrante.texto.length, cliente: enmascararTelefono(c.clienteWa) });',
    'console.log("[x] el texto del cliente no se loguea", e);', // la palabra dentro de un string no cuenta
    'console.log(`[c] ${conv.clienteWa} respondió`); // log-pii-ok: prueba de la excepción',
    'console.log(`[t] ${`anidado ${enmascararTelefono(clienteWa)}`}`);',
  ];
  for (const fuente of buenos) assert.deepEqual(violacionesEnFuente(fuente), [], `no debió detectar: ${fuente}`);
});

test("enmascararTelefono: deja prefijo de país + últimos 4, nunca el número completo", () => {
  assert.equal(enmascararTelefono("50688887777"), "506***7777");
  assert.equal(enmascararTelefono("+506 8888-7777"), "506***7777");
  assert.equal(enmascararTelefono("88887777"), "***77");
  assert.equal(enmascararTelefono("506***7777"), "506***7777", "idempotente");
  assert.equal(enmascararTelefono(""), "—");
  assert.equal(enmascararTelefono(undefined), "—");
  assert.ok(!enmascararTelefono("50688887777").includes("8888"));
});

test("describirTexto: solo la longitud, nunca el contenido", () => {
  assert.equal(describirTexto("Hola, quiero una cita"), "[21 car.]");
  assert.equal(describirTexto(""), "[vacío]");
  assert.equal(describirTexto(null), "[vacío]");
});

test("log.*: red de seguridad — clienteWa/texto/respuesta/contenido salen saneados aunque se olviden del helper", () => {
  const original = console.log;
  const lineas: string[] = [];
  console.log = (linea: string) => lineas.push(linea);
  try {
    log.info("prueba_pii", { tenantId: "t1", clienteWa: "50688887777", texto: "mi cédula es 1-1111-1111", respuesta: "ok", contenido: "x" });
  } finally {
    console.log = original;
  }
  const obj = JSON.parse(lineas[0]);
  assert.equal(obj.tenantId, "t1");
  assert.equal(obj.clienteWa, "506***7777");
  assert.equal(obj.texto, "[24 car.]");
  assert.equal(obj.respuesta, "[2 car.]");
  assert.equal(obj.contenido, "[1 car.]");
  assert.ok(!lineas[0].includes("cédula"));
});
