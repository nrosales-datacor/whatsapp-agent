import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { log } from "../../src/platform/observability/log";
import { describeText, maskPhone } from "../../src/platform/observability/privacy";

// ─────────────────────────────────────────────────────────────────────────────
// Datos personales en los logs (Ley 8968). Los logs llegaron a escribir el teléfono
// completo del cliente y hasta 80 caracteres de cada mensaje (entrante, transcripción de
// audio, respuesta del bot).
//
// Este test recorre TODO src/ y falla si un console.* / log.* interpola una variable con
// nombre de dato personal (phone, clientPhone, text, reply, content, transcript, notes)
// sin pasar por maskPhone()/describeText() de src/platform/observability/privacy.ts.
// `x.length` está permitido (es solo la longitud). Excepción explícita y revisable: un
// comentario `// log-pii-ok: motivo` en la línea de la llamada.
// ─────────────────────────────────────────────────────────────────────────────

const SRC_ROOT = fileURLToPath(new URL("../../src/", import.meta.url));
const HELPERS = ["maskPhone", "describeText", "sanitizeLogFields"];
const CALL_START = /(?<![\w$.])(?:console\.(?:log|warn|error|info|debug)|log\.(?:info|warn|error))\s*\(/g;

/** Identificadores que nombran un teléfono del cliente o el contenido de un mensaje. */
function isPiiName(id: string): boolean {
  return (
    /^(clientPhone|phone|text|reply|content|transcript|notes)(?=[A-Z0-9_]|$)/.test(id) ||
    /(ClientPhone|Phone|Text|Reply|Content|Transcript|Transcribed|Notes)$/.test(id)
  );
}

/**
 * Desde `start` (justo después del `(` de la llamada) devuelve el código de los
 * argumentos SIN el texto estático de los strings (sí con las expresiones `${…}` de los
 * template literals) y el índice donde cierra la llamada.
 */
function argumentsAsCode(source: string, start: number): { code: string; end: number } {
  let code = "";
  let i = start;
  // Pila de contextos: "code" (con su profundidad de paréntesis/llaves) o "template".
  const stack: Array<{ kind: "code"; depth: number } | { kind: "template" }> = [{ kind: "code", depth: 1 }];
  while (i < source.length) {
    const top = stack[stack.length - 1];
    const c = source[i];
    if (top.kind === "template") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { stack.pop(); code += '""'; i++; continue; }
      if (c === "$" && source[i + 1] === "{") { stack.push({ kind: "code", depth: 1 }); code += " ("; i += 2; continue; }
      i++;
      continue;
    }
    // Contexto de código.
    if (c === "/" && source[i + 1] === "/") { while (i < source.length && source[i] !== "\n") i++; continue; }
    if (c === "/" && source[i + 1] === "*") { i = source.indexOf("*/", i + 2) + 2; continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < source.length && source[i] !== c) i += source[i] === "\\" ? 2 : 1;
      i++;
      code += '""';
      continue;
    }
    if (c === "`") { stack.push({ kind: "template" }); i++; continue; }
    if (c === "(" || c === "{" || c === "[") top.depth++;
    if (c === ")" || c === "}" || c === "]") {
      top.depth--;
      if (top.depth === 0) {
        stack.pop();
        if (stack.length === 0) return { code, end: i };
        code += ") "; // cierre de un `${…}`: vuelve al template
        i++;
        continue;
      }
    }
    code += c;
    i++;
  }
  return { code, end: source.length };
}

/** Borra las llamadas a los helpers (con sus argumentos balanceados): lo que pasa por ellos está saneado. */
function withoutHelpers(code: string): string {
  let out = code;
  for (;;) {
    const m = new RegExp(`\\b(?:${HELPERS.join("|")})\\s*\\(`).exec(out);
    if (!m) return out;
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < out.length && depth > 0) {
      if (out[i] === "(") depth++;
      else if (out[i] === ")") depth--;
      i++;
    }
    out = out.slice(0, m.index) + "SANITIZED" + out.slice(i);
  }
}

/** Devuelve las violaciones de un archivo fuente: "línea: identificador". */
export function violationsInSource(source: string): string[] {
  const violations: string[] = [];
  const lines = source.split(/\r?\n/);
  for (const m of source.matchAll(CALL_START)) {
    const start = m.index! + m[0].length;
    const { code, end } = argumentsAsCode(source, start);
    const firstLine = source.slice(0, m.index).split("\n").length;
    const lastLine = source.slice(0, end).split("\n").length;
    const text = lines.slice(firstLine - 1, lastLine).join("\n");
    if (text.includes("log-pii-ok:")) continue;
    const clean = withoutHelpers(code);
    for (const id of clean.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*(?![\w$])(?!\s*\.\s*length\b)/g)) {
      if (isPiiName(id[0])) violations.push(`${firstLine}: ${id[0]}`);
    }
  }
  return violations;
}

function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* tsFiles(p);
    else if (/\.tsx?$/.test(e.name)) yield p;
  }
}

test("ningún console.*/log.* de src/ interpola teléfonos o contenido de mensajes sin el helper", () => {
  const all: string[] = [];
  for (const file of tsFiles(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file).replace(/\\/g, "/");
    for (const v of violationsInSource(readFileSync(file, "utf8"))) all.push(`src/${rel}:${v}`);
  }
  assert.deepEqual(
    all,
    [],
    "Logs con datos personales. Usá maskPhone()/describeText() (src/platform/observability/privacy.ts), " +
      "logueá solo `.length`, o marcá la línea con `// log-pii-ok: motivo` si de verdad no es un dato personal.",
  );
});

test("el detector caza los patrones peligrosos y deja pasar los saneados (autotest)", () => {
  const bad = [
    'console.log(`[inbound] ${inbound.clientPhone}: "${inbound.text.slice(0, 80)}"`);',
    'console.log(`[outbound] → ${to}: "${reply.slice(0, 80)}"`);',
    'console.log(`[audio] ${x}: "${audioTranscript.slice(0, 80)}"`);',
    'log.info("event", { tenantId, client: conv.clientPhone });',
    'console.error("[x] falló para", candidate.phone, e);',
    "console.log(\n  `[panel] ${a}: \"${text.slice(0, 60)}\"`,\n);",
  ];
  for (const source of bad) assert.notDeepEqual(violationsInSource(source), [], `debió detectar: ${source}`);

  const good = [
    'console.log(`[inbound] ${maskPhone(inbound.clientPhone)} ${describeText(inbound.text)}`);',
    'log.info("inbound", { tenantId: t.id, length: inbound.text.length, client: maskPhone(c.clientPhone) });',
    'console.log("[x] el text del cliente no se loguea", e);', // la palabra dentro de un string no cuenta
    'console.log(`[c] ${conv.clientPhone} respondió`); // log-pii-ok: prueba de la excepción',
    'console.log(`[t] ${`anidado ${maskPhone(clientPhone)}`}`);',
    'console.log(`[storage] ${path} ${textureCount}`);', // "textureCount" no es "text…" + mayúscula
  ];
  for (const source of good) assert.deepEqual(violationsInSource(source), [], `no debió detectar: ${source}`);
});

test("maskPhone: deja prefijo de país + últimos 4, nunca el número completo", () => {
  assert.equal(maskPhone("50688887777"), "506***7777");
  assert.equal(maskPhone("+506 8888-7777"), "506***7777");
  assert.equal(maskPhone("88887777"), "***77");
  assert.equal(maskPhone("506***7777"), "506***7777", "idempotente");
  assert.equal(maskPhone(""), "—");
  assert.equal(maskPhone(undefined), "—");
  assert.ok(!maskPhone("50688887777").includes("8888"));
});

test("describeText: solo la longitud, nunca el contenido", () => {
  assert.equal(describeText("Hola, quiero una cita"), "[21 car.]");
  assert.equal(describeText(""), "[vacío]");
  assert.equal(describeText(null), "[vacío]");
});

test("log.*: red de seguridad — phone/text/reply/content salen saneados aunque se olviden del helper", () => {
  const original = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    log.info("pii_test", { tenantId: "t1", phone: "50688887777", text: "mi cédula es 1-1111-1111", reply: "ok", content: "x" });
  } finally {
    console.log = original;
  }
  const obj = JSON.parse(lines[0]);
  assert.equal(obj.tenantId, "t1");
  assert.equal(obj.phone, "506***7777");
  assert.equal(obj.text, "[24 car.]");
  assert.equal(obj.reply, "[2 car.]");
  assert.equal(obj.content, "[1 car.]");
  assert.ok(!lines[0].includes("cédula"));
});
