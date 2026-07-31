import assert from "node:assert/strict";
import { test } from "node:test";
import { cargarCasos, evaluar, herramientasMencionadas, type Espera, type ToolObservada } from "../../eval/aserciones";
import { crearTenantEval } from "../../eval/fixtureEval";
import { TOOLS } from "../../src/agent/tools";
import { construirSystemPrompt } from "../../src/agent/systemPrompt";

// ─────────────────────────────────────────────────────────────────────────────
// Tests del HARNESS de evals, no del agente. Las evals en sí llaman a OpenAI real
// (`npm run eval`, cuesta tokens y no corre en CI); esto verifica que su lógica pura
// —las aserciones, el fixture y los casos— esté sana, de forma determinista y sin red.
//
// Por qué importa: un typo en el nombre de una herramienta dentro de un JSON, o una
// aserción con la comparación al revés, haría que una eval falle (o pase) por el
// motivo equivocado. Eso se leería como "el agente se rompió" y costaría una tarde
// de depuración a quien corra las evals meses después.
// ─────────────────────────────────────────────────────────────────────────────

const OK = { respuesta: "listo", escalar: false, fueraDeAlcance: false };
const ANIO = "2026";

function tool(nombre: string, args: Record<string, unknown> = {}): ToolObservada {
  return { nombre, args };
}

// ── sinMonto: la política dura de Selyon ────────────────────────────────────────

test("sinMonto: detecta montos en las formas que un bot realmente escribe", () => {
  const conMonto = [
    "Te sale ₡350.000 más IVA",
    "Andaría por los $2,500",
    "Rondaría los 500 mil colones",
    "Un proyecto así cuesta como 2 millones",
    "Estamos hablando de un millón y medio",
    "Serían 800000 colones",
  ];
  for (const respuesta of conMonto) {
    const fallos = evaluar({ sinMonto: true }, { ...OK, respuesta }, [], ANIO);
    assert.equal(fallos.length, 1, `debería detectar el monto en: ${respuesta}`);
    assert.match(fallos[0], /menciona un monto/);
  }
});

test("sinMonto: no da falsos positivos con números que NO son montos", () => {
  // Duraciones, horas, fechas y cantidades son parte normal de la conversación:
  // si estos fallaran, el caso 03 (el cliente presionando por precio) sería inusable.
  const sinMonto = [
    "La reunión es gratis y dura 30 min",
    "Te puedo dar espacio mañana a las 8:00 o a las 14:30",
    "Agendada para el 2026-08-03 ✅",
    "Trabajamos con clientes de 3 países",
    "Somos un equipo de 5 personas",
  ];
  for (const respuesta of sinMonto) {
    assert.deepEqual(evaluar({ sinMonto: true }, { ...OK, respuesta }, [], ANIO), [], `falso positivo en: ${respuesta}`);
  }
});

// ── argIncluye: eligió el servicio correcto, no solo la herramienta correcta ────

test("argIncluye: pasa cuando alguna llamada trae todos los args esperados", () => {
  const espera: Espera = { argIncluye: { herramienta: "agendar_cita", args: { servicioId: "demo" } } };
  const tools = [tool("consultar_disponibilidad", { fecha: "2026-08-03" }), tool("agendar_cita", { servicioId: "demo", hora: "11:00" })];
  assert.deepEqual(evaluar(espera, OK, tools, ANIO), []);
});

test("argIncluye: falla cuando la herramienta se llamó con OTRO servicio", () => {
  const espera: Espera = { argIncluye: { herramienta: "agendar_cita", args: { servicioId: "demo" } } };
  const fallos = evaluar(espera, OK, [tool("agendar_cita", { servicioId: "reunion-diagnostico" })], ANIO);
  assert.equal(fallos.length, 1);
  // El mensaje debe mostrar con qué SÍ se llamó, para poder diagnosticar sin re-correr.
  assert.match(fallos[0], /reunion-diagnostico/);
});

test("argIncluye: falla (sin reventar) si la herramienta nunca se llamó", () => {
  const espera: Espera = { argIncluye: { herramienta: "agendar_cita", args: { servicioId: "demo" } } };
  const fallos = evaluar(espera, OK, [], ANIO);
  assert.equal(fallos.length, 1);
  assert.match(fallos[0], /se usaron: \(ninguna\)/);
});

// ── fechaAnioActual: el bug clásico de agendar en un año pasado ─────────────────

test("fechaAnioActual: detecta un año distinto al actual y acepta el correcto", () => {
  const espera: Espera = { fechaAnioActual: true };
  assert.equal(evaluar(espera, OK, [tool("agendar_cita", { fecha: "2024-08-03" })], ANIO).length, 1);
  assert.deepEqual(evaluar(espera, OK, [tool("agendar_cita", { fecha: "2026-08-03" })], ANIO), []);
  // Sin argumento `fecha` no hay nada que validar (no debe inventar un fallo).
  assert.deepEqual(evaluar(espera, OK, [tool("consultar_mi_cita")], ANIO), []);
});

// ── Aserciones booleanas: que no estén invertidas ──────────────────────────────

test("escala / fueraDeAlcance / interactivo: ambos sentidos de cada aserción", () => {
  assert.equal(evaluar({ escala: true }, OK, [], ANIO).length, 1);
  assert.deepEqual(evaluar({ escala: true }, { ...OK, escalar: true }, [], ANIO), []);
  assert.equal(evaluar({ escala: false }, { ...OK, escalar: true }, [], ANIO).length, 1);

  assert.equal(evaluar({ fueraDeAlcance: true }, OK, [], ANIO).length, 1);
  assert.deepEqual(evaluar({ fueraDeAlcance: true }, { ...OK, fueraDeAlcance: true }, [], ANIO), []);

  assert.equal(evaluar({ interactivo: true }, OK, [], ANIO).length, 1);
  assert.deepEqual(evaluar({ interactivo: true }, { ...OK, interactivo: { tipo: "lista" } }, [], ANIO), []);
  assert.equal(evaluar({ interactivo: false }, { ...OK, interactivo: { tipo: "lista" } }, [], ANIO).length, 1);
});

test("sinHerramienta y herramientaNo: detectan la herramienta indebida", () => {
  assert.deepEqual(evaluar({ sinHerramienta: true }, OK, [], ANIO), []);
  assert.equal(evaluar({ sinHerramienta: true }, OK, [tool("agendar_cita")], ANIO).length, 1);
  assert.equal(
    evaluar({ herramientaNo: "registrar_cotizacion" }, OK, [tool("registrar_cotizacion")], ANIO).length,
    1,
  );
  assert.deepEqual(evaluar({ herramientaNo: "registrar_cotizacion" }, OK, [tool("agendar_cita")], ANIO), []);
});

test("evaluar: acumula TODOS los fallos de un caso, no solo el primero", () => {
  const fallos = evaluar(
    { herramienta: "agendar_cita", escala: false, sinMonto: true },
    { respuesta: "Te sale ₡90.000", escalar: true, fueraDeAlcance: false },
    [],
    ANIO,
  );
  assert.equal(fallos.length, 3);
});

// ── Los casos reales del repo ──────────────────────────────────────────────────

test("transcripciones: los casos cargan y están bien formados", () => {
  const casos = cargarCasos();
  assert.ok(casos.length >= 14, `esperaba al menos 14 casos, hay ${casos.length}`);

  const nombres = new Set<string>();
  for (const c of casos) {
    assert.ok(c.nombre, "todo caso necesita nombre (se usa para filtrar con EVAL_CASO)");
    assert.equal(nombres.has(c.nombre), false, `nombre de caso duplicado: ${c.nombre}`);
    nombres.add(c.nombre);
    assert.ok(c.usuario, `el caso ${c.nombre} no tiene mensaje del cliente`);
    assert.ok(c.espera && Object.keys(c.espera).length > 0, `el caso ${c.nombre} no asevera nada`);
  }
});

test("transcripciones: toda herramienta esperada existe de verdad en TOOLS", () => {
  // Un typo acá ("agendar_citas") haría fallar la eval por el motivo equivocado.
  // `ChatCompletionTool` es una unión en el SDK (function | custom); solo las de
  // tipo "function" tienen nombre, y son las únicas que usa el agente.
  const reales = new Set(TOOLS.filter((t) => t.type === "function").map((t) => t.function.name));
  for (const c of cargarCasos()) {
    for (const nombre of herramientasMencionadas(c.espera)) {
      assert.ok(reales.has(nombre), `el caso ${c.nombre} menciona una herramienta inexistente: ${nombre}`);
    }
  }
});

test("transcripciones: los servicioId sembrados o aseverados existen en el fixture", () => {
  const ids = new Set(crearTenantEval().servicios.map((s) => s.id));
  for (const c of cargarCasos()) {
    for (const s of c.seedCitas ?? []) {
      assert.ok(ids.has(s.servicioId), `el caso ${c.nombre} siembra un servicio inexistente: ${s.servicioId}`);
    }
    const esperado = c.espera.argIncluye?.args?.servicioId;
    if (typeof esperado === "string") {
      assert.ok(ids.has(esperado), `el caso ${c.nombre} espera un servicio inexistente: ${esperado}`);
    }
  }
});

// ── El fixture, contra el prompt real de producción ───────────────────────────

test("fixture de eval: produce un prompt con la persona de Selyon y la agenda activa", () => {
  const prompt = construirSystemPrompt(crearTenantEval());
  assert.match(prompt, /Selyon/);
  assert.match(prompt, /software/i);
  // Registro "vos" (B7): el prompt debe pedir el trato correcto.
  assert.match(prompt, /tratando al cliente de vos/);
  // Tiene servicios agendables → las reglas de agenda deben estar presentes.
  assert.match(prompt, /AGENDAR/);
  // Las instrucciones del negocio (la política de no dar precios) deben inyectarse:
  // es lo que miden los casos 02 y 03.
  assert.match(prompt, /NO des precios ni plazos exactos por chat/);
  // La sección libre de la KB (B6) se inyecta bajo su propio título.
  assert.match(prompt, /## Qué hacemos/);
});

test("fixture de eval: el add-on solo aparece con upsell activado", () => {
  const sinUpsell = crearTenantEval().servicios.find((s) => s.id === "reunion-diagnostico");
  assert.equal(sinUpsell?.addonActivo, undefined);
  assert.equal(sinUpsell?.addonSugeridoId, undefined);

  const conUpsell = crearTenantEval({ upsell: true }).servicios.find((s) => s.id === "reunion-diagnostico");
  assert.equal(conUpsell?.addonActivo, true);
  assert.equal(conUpsell?.addonSugeridoId, "demo");
});

test("fixture de eval: abre todos los días (estabilidad de los casos de agenda)", () => {
  // Si algún día quedara cerrado, un caso que dice "mañana" fallaría según el día
  // en que corran las evals. Ver la nota en fixtureEval.ts.
  const horario = crearTenantEval().horario;
  for (let dia = 0; dia <= 6; dia++) {
    assert.ok(horario[dia]?.abre, `el día ${dia} debería estar abierto en el fixture de eval`);
  }
});
