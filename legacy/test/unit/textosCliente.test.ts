import "../helpers/setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOTONES,
  CLAVES_TEXTO,
  esRespuestaFueraDeAlcance,
  interpolar,
  PLANTILLAS,
  registroDe,
  textoCliente,
  validarTextosCliente,
} from "../../src/config/textos";
import { construirSystemPrompt } from "../../src/agent/systemPrompt";
import { confirmacionDeAccion } from "../../src/agent/runAgent";
import { textoPedidoConsentimiento } from "../../src/campaigns/consentimiento";
import { TOOLS } from "../../src/agent/tools";
import { crearTenant } from "../helpers/fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// E11 — textos del sistema al cliente final (src/config/textos.ts): plantillas por
// registro (vos/tú/usted), override por tenant, y la regla de que ningún texto
// voseado fijo quede fuera del módulo. Puros, sin red ni base.
// ─────────────────────────────────────────────────────────────────────────────

const tico = crearTenant({ timezone: "America/Costa_Rica" }); // registro inferido: vos
const mexicano = crearTenant({ timezone: "America/Mexico_City", nombre: "Barbería Centro" }); // tú
const colombiano = crearTenant({ timezone: "America/Bogota", nombre: "Clínica Norte" }); // usted

// Formas verbales del voseo que NO deben aparecer en tú/usted (y que delatan un texto
// voseado fijo fuera del módulo). Sin `\b`: en JS no es Unicode-aware con tildes.
const FORMAS_VOSEO = [
  "podés",
  "tenés",
  "querés",
  "necesitás",
  "preferís",
  "sabés",
  "confirmás",
  "repetís",
  "disculpá",
  "probá",
  "escribí",
  "mandá",
  "contame",
  "dejame",
  "mandame",
  "avisame",
  "decime",
  "escribinos",
  "contanos",
  "mirala",
  "ayudalo",
];
const RE_VOSEO = new RegExp(`(?<![\\p{L}])(${FORMAS_VOSEO.join("|")})(?![\\p{L}])`, "iu");
const RE_TUTEO_O_VOSEO_DIRIGIDO = /(?<![\p{L}])(te|tu|tuyos?|contigo|ti)(?![\p{L}])/iu;

test("registroDe: el configurado manda; si no, se infiere del país por la zona horaria", () => {
  assert.equal(registroDe(tico), "vos");
  assert.equal(registroDe(mexicano), "tu");
  assert.equal(registroDe(colombiano), "usted");
  assert.equal(registroDe(crearTenant({ timezone: "America/Costa_Rica", registro: "usted" })), "usted");
  assert.equal(registroDe(crearTenant({ timezone: "Europe/Madrid" })), "tu", "fuera del mapa: neutro (tú)");
});

test("catálogo: todas las claves tienen los tres registros, sin 🚗 ni espacios sobrantes", () => {
  for (const clave of CLAVES_TEXTO) {
    for (const reg of ["vos", "tu", "usted"] as const) {
      const t = PLANTILLAS[clave][reg];
      assert.ok(t && t.trim() === t, `${clave}/${reg} vacío o con espacios`);
      assert.ok(!t.includes("🚗"), `${clave}/${reg} trae el emoji de carro (rubro-específico)`);
    }
  }
});

test("tú y usted no traen formas de voseo; usted tampoco tutea al cliente", () => {
  for (const clave of CLAVES_TEXTO) {
    assert.doesNotMatch(PLANTILLAS[clave].tu, RE_VOSEO, `tu/${clave}`);
    assert.doesNotMatch(PLANTILLAS[clave].usted, RE_VOSEO, `usted/${clave}`);
    // Usted no se dirige al cliente con te/tu/tuyo/contigo.
    assert.doesNotMatch(PLANTILLAS[clave].usted, RE_TUTEO_O_VOSEO_DIRIGIDO, `usted/${clave}`);
  }
});

test("vos (piloto): los textos de siempre, salvo el 🚗 que se fue", () => {
  assert.equal(textoCliente(tico, "errorGeneral"), "Disculpá, tuvimos un problemita. Probá de nuevo en un momento 🙏");
  assert.equal(
    textoCliente(tico, "avisoBot", { negocio: "Lavacar Rosales" }),
    "👋 ¡Hola! Soy el asistente automatizado de Lavacar Rosales. Puedo darte info de servicios, precios y horarios, y agendarte una cita. Escribí *agente* si preferís hablar con una persona.",
  );
  assert.equal(textoCliente(tico, "escalada"), "Dejame consultarlo con una persona del equipo 🙋 En un momento te responden por acá.");
  assert.equal(textoCliente(tico, "citaConfirmadaAck"), "¡Gracias por confirmar tu cita! ✅ Te esperamos.");
});

test("tú y usted: el mismo mensaje en el trato del negocio", () => {
  assert.equal(textoCliente(mexicano, "errorGeneral"), "Disculpa, tuvimos un problemita. Prueba de nuevo en un momento 🙏");
  assert.equal(textoCliente(colombiano, "errorGeneral"), "Disculpe, tuvimos un problemita. Pruebe de nuevo en un momento 🙏");
  assert.match(textoCliente(colombiano, "avisoBot", { negocio: "Clínica Norte" }), /Escriba \*agente\* si prefiere/);
  assert.match(textoCliente(mexicano, "recordatorioCita", { cliente: "Ana", negocio: "X", cuando: "hoy", servicio: "Corte" }), /¿Nos confirmas\?$/);
});

test("override por tenant: reemplaza la plantilla (con variables); vacío o no-texto cae al catálogo", () => {
  const t = crearTenant({
    timezone: "America/Costa_Rica",
    textosCliente: { escalada: "One moment, {negocio} will get back to you.", errorGeneral: "   " },
  });
  assert.equal(textoCliente(t, "escalada", { negocio: "Acme" }), "One moment, Acme will get back to you.");
  assert.equal(textoCliente(t, "errorGeneral"), PLANTILLAS.errorGeneral.vos, "override en blanco = sin override");
  const roto = crearTenant({ textosCliente: { escalada: 42 as unknown as string } });
  assert.equal(textoCliente(roto, "escalada"), PLANTILLAS.escalada.vos, "un valor raro en el JSONB no tumba el envío");
});

test("interpolar: reemplaza las variables conocidas y deja las desconocidas tal cual", () => {
  assert.equal(interpolar("{a} y {b} y {c}", { a: 1, b: "dos" }), "1 y dos y {c}");
});

test("validarTextosCliente: claves del catálogo, texto acotado, vacíos descartados", () => {
  assert.deepEqual(validarTextosCliente(undefined), {});
  assert.deepEqual(validarTextosCliente({ escalada: "  hola  ", errorGeneral: "" }), { escalada: "hola" });
  assert.equal(validarTextosCliente({ claveInventada: "x" }), null);
  assert.equal(validarTextosCliente({ escalada: 3 }), null);
  assert.equal(validarTextosCliente({ escalada: "x".repeat(1001) }), null);
  assert.equal(validarTextosCliente(["escalada"]), null);
});

test("botones: títulos dentro del límite de 20 caracteres de Meta", () => {
  for (const [k, v] of Object.entries(BOTONES)) assert.ok(v.length <= 20, `${k}: "${v}"`);
});

test("confirmacionDeAccion usa el registro del negocio", () => {
  const resultado = JSON.stringify({ ok: true, cita: { servicioId: "pulido", fecha: "2026-07-20", hora: "09:00" } });
  assert.match(confirmacionDeAccion("agendar_cita", resultado, tico)!, /^✅ Tu cita quedó agendada: Pulido, /);
  assert.match(confirmacionDeAccion("agendar_cita", resultado, colombiano)!, /^✅ Su cita quedó agendada: Pulido, /);
});

test("consentimiento: el pedido nombra al negocio y respeta el registro", () => {
  assert.match(textoPedidoConsentimiento(tico), /Lavacar Rosales te avise.*podés darte de baja/);
  assert.match(textoPedidoConsentimiento(colombiano), /Clínica Norte le avise.*puede darse de baja/);
});

test("esRespuestaFueraDeAlcance: detecta la deflección en los tres registros y en inglés", () => {
  for (const reg of ["vos", "tu", "usted"] as const) {
    assert.ok(esRespuestaFueraDeAlcance(interpolar(PLANTILLAS.fueraDeAlcance[reg], { negocio: "X" })), reg);
  }
  assert.ok(esRespuestaFueraDeAlcance("Sorry, I can only help with things about Acme 🙂"));
  assert.ok(!esRespuestaFueraDeAlcance("El lavado básico cuesta ₡5 000."));
});

test("system prompt: responde en el idioma del cliente y el ejemplo de fuera de alcance va en el registro del negocio", () => {
  const pTico = construirSystemPrompt(tico);
  assert.match(pTico, /idioma en que te escribe el cliente/);
  assert.match(pTico, /tratando al cliente de vos/);
  assert.match(pTico, /"Disculpá, solo puedo ayudarte con cosas de Lavacar Rosales/);
  const pCol = construirSystemPrompt(colombiano);
  assert.match(pCol, /tratando al cliente de usted/);
  assert.match(pCol, /"Disculpe, solo puedo ayudarle con cosas de Clínica Norte/);
  assert.doesNotMatch(pCol, /Hablá en español/);
});

test("agendar_cita: el dato identificador es genérico (referencia), sin 'placa del vehículo'", () => {
  const agendar = TOOLS.find((t) => t.type === "function" && t.function.name === "agendar_cita");
  assert.ok(agendar && agendar.type === "function");
  const json = JSON.stringify(agendar.function.parameters);
  assert.ok(json.includes('"referencia"'));
  assert.doesNotMatch(json, /veh[ií]culo|"placa"/i);
});

// ── Guardián: ningún texto voseado fijo fuera del módulo ──────────────────────
// Recorre src/ y busca formas de voseo típicas de los mensajes al cliente en líneas
// de código (no comentarios). Las excepciones son archivos que NO le hablan al
// cliente final, con su motivo.
const EXCEPCIONES: Record<string, string> = {
  "src/config/textos.ts": "el módulo de textos: acá SÍ viven las plantillas en voseo",
  "src/agent/systemPrompt.ts": "instrucciones al MODELO (el registro al cliente sale de FRASE_REGISTRO)",
  "src/agent/tools.ts": "descripciones de herramientas para el MODELO",
  "src/config/tenants.ts": "datos del tenant semilla (Selyon): contenido editable del negocio, no texto del sistema",
};
const DIRS_EXCEPTUADOS = ["src/panel/"]; // API del panel: la lee el dueño/operador, no el cliente final

function archivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) out.push(...archivosTs(ruta));
    else if (ruta.endsWith(".ts")) out.push(ruta);
  }
  return out;
}

test("no quedan textos voseados fijos ni 🚗 en src/ fuera de config/textos.ts", () => {
  // El detector en sí: agarra el voseo con tilde y no confunde palabras más largas.
  assert.match('"Disculpá, tuvimos un problemita"', RE_VOSEO);
  assert.match("Escribinos por acá", RE_VOSEO);
  assert.doesNotMatch("si probáramos otra vez", RE_VOSEO);

  const raiz = fileURLToPath(new URL("../..", import.meta.url));
  const hallazgos: string[] = [];
  for (const archivo of archivosTs(join(raiz, "src"))) {
    const rel = relative(raiz, archivo).split(sep).join("/");
    if (EXCEPCIONES[rel] || DIRS_EXCEPTUADOS.some((d) => rel.startsWith(d))) continue;
    readFileSync(archivo, "utf8")
      .split("\n")
      .forEach((linea, i) => {
        const t = linea.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return; // comentarios
        if (RE_VOSEO.test(linea) || linea.includes("🚗")) hallazgos.push(`${rel}:${i + 1}: ${t.slice(0, 120)}`);
      });
  }
  assert.deepEqual(hallazgos, [], "mover estos textos a src/config/textos.ts (plantilla por registro)");
});
