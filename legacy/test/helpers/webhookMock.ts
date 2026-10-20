// ─────────────────────────────────────────────────────────────────────────────
// Mock de red para el E2E del webhook (ángulo 3 de TESTING.md). Intercepta
// `globalThis.fetch` y atiende, SIN tocar la red, los tres destinos que usa el
// flujo de respuesta:
//
//   1) Graph API — envío de mensajes (POST …/messages): se capturan en `enviados`
//      para afirmar QUÉ le respondió el bot al cliente (texto o interactivo).
//   2) Graph API — descarga de media (GET …/{mediaId} y luego la URL temporal):
//      devuelve unos bytes de imagen falsos, para la rama de visión (C1.5).
//   3) OpenAI (POST …/chat/completions): devuelve turnos PROGRAMADOS por el test
//      (texto final, tool_call, o escalada), para manejar el agente de forma
//      100% determinista. `solicitudesLLM` guarda los cuerpos enviados (para
//      afirmar, p. ej., que la foto viajó como image_url).
//
// Por qué un dispatcher persistente: el SDK de OpenAI captura `globalThis.fetch`
// UNA vez, al construir su cliente singleton (perezoso, en el primer mensaje). Si
// reinstaláramos un fetch nuevo por test, el cliente quedaría atado al viejo. Por
// eso instalamos UN dispatcher estable que consulta un `escenario` mutable; cada
// test lo resetea con `instalarMockWebhook()`. Sin escenario activo, el dispatcher
// delega en el fetch original (no rompe otros tests que no usan red).
// ─────────────────────────────────────────────────────────────────────────────

export interface EnviadoWa {
  tipo: string; // "text" | "interactive" | "template"
  to: string;
  texto?: string; // cuerpo, cuando tipo === "text"
  interactive?: any; // payload interactivo (botones/lista), cuando tipo === "interactive"
  raw: any;
}

/**
 * Un turno programado del "LLM": texto final, una tool call, escalada a humano, o un
 * error HTTP de OpenAI (E7: 429/503 transitorios, 400 permanente). El error va con
 * `x-should-retry: false` para que el SDK NO lo reintente por su cuenta: cada turno
 * programado = exactamente un intento, y el reintento que se prueba es el de la cola.
 */
export type TurnoLLM =
  | { texto: string }
  | { tool: string; args?: Record<string, unknown> }
  | { escalar: string }
  | { errorHttp: number };

interface Escenario {
  enviados: EnviadoWa[];
  colaLLM: TurnoLLM[];
  solicitudesLLM: any[];
}

let fetchOriginal: typeof globalThis.fetch | null = null;
let escenario: Escenario | null = null;
let contadorCall = 0;

function jsonRes(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function turnoAChatCompletion(turno: Exclude<TurnoLLM, { errorHttp: number }>): { message: any; finish_reason: string } {
  if ("texto" in turno) {
    return { message: { role: "assistant", content: turno.texto }, finish_reason: "stop" };
  }
  const id = `call_${++contadorCall}`;
  const { name, args } =
    "escalar" in turno
      ? { name: "escalar_a_humano", args: { motivo: turno.escalar } }
      : { name: turno.tool, args: turno.args ?? {} };
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
    finish_reason: "tool_calls",
  };
}

async function dispatcher(input: any, init?: any): Promise<Response> {
  if (!escenario) {
    if (!fetchOriginal) throw new Error("mock webhook: no hay fetch original");
    return fetchOriginal(input, init);
  }
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? input);
  const method = String(init?.method ?? "GET").toUpperCase();

  // 3) OpenAI — turno programado.
  if (url.includes("api.openai.com") && url.includes("/chat/completions")) {
    escenario.solicitudesLLM.push(init?.body ? JSON.parse(String(init.body)) : null);
    const turno = escenario.colaLLM.shift();
    if (!turno) throw new Error("mock LLM: llamada a OpenAI sin turno programado (programá con programarLLM)");
    if ("errorHttp" in turno) {
      return new Response(JSON.stringify({ error: { message: `mock ${turno.errorHttp}`, type: "server_error" } }), {
        status: turno.errorHttp,
        headers: { "content-type": "application/json", "x-should-retry": "false" },
      });
    }
    const { message, finish_reason } = turnoAChatCompletion(turno);
    return jsonRes({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: "gpt-4o-mini",
      choices: [{ index: 0, message, finish_reason }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  // 1) Graph API — envío de mensaje.
  if (url.includes("graph.facebook.com") && url.includes("/messages") && method === "POST") {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    escenario.enviados.push({
      tipo: String(body.type ?? "?"),
      to: String(body.to ?? ""),
      texto: body.type === "text" ? body.text?.body : undefined,
      interactive: body.type === "interactive" ? body.interactive : undefined,
      raw: body,
    });
    return jsonRes({ messages: [{ id: `wamid.out.${escenario.enviados.length}` }] });
  }

  // 2) Graph API — metadata de media (paso 1: devuelve la URL temporal del archivo).
  if (url.includes("graph.facebook.com") && method === "GET") {
    return jsonRes({ url: "https://media.test/archivo.jpg", mime_type: "image/jpeg" });
  }

  // 2) Graph API — bytes del archivo (paso 2). JPEG mínimo (SOI + EOI).
  if (url.startsWith("https://media.test/")) {
    return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  }

  throw new Error(`mock webhook: URL no manejada: ${method} ${url}`);
}

export interface MockWebhook {
  /** Mensajes que el bot "envió" al cliente vía Graph API, en orden. */
  enviados: EnviadoWa[];
  /** Cuerpos de las requests hechas a OpenAI (para afirmar el prompt / la imagen). */
  solicitudesLLM: any[];
  /** Programa los próximos turnos del LLM (se consumen FIFO por cada llamada del agente). */
  programarLLM: (...turnos: TurnoLLM[]) => void;
  /** Cuántas veces se llamó a OpenAI (para afirmar "el agente NO se invocó"). */
  llamadasLLM: () => number;
}

/** Activa/resetea el mock para un test. Idempotente en cuanto a la instalación del dispatcher. */
export function instalarMockWebhook(): MockWebhook {
  if (!fetchOriginal) {
    fetchOriginal = globalThis.fetch;
    globalThis.fetch = dispatcher as typeof globalThis.fetch;
  }
  // El SDK de OpenAI exige una API key para construir su cliente (no hace red al construir).
  if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = "sk-test";
  const e: Escenario = { enviados: [], colaLLM: [], solicitudesLLM: [] };
  escenario = e;
  return {
    enviados: e.enviados,
    solicitudesLLM: e.solicitudesLLM,
    programarLLM: (...turnos) => e.colaLLM.push(...turnos),
    llamadasLLM: () => e.solicitudesLLM.length,
  };
}

/** Desactiva el mock (el dispatcher queda instalado pero delega en el fetch real). */
export function desactivarMockWebhook(): void {
  escenario = null;
}

/** Construye el cuerpo de un webhook de WhatsApp con un mensaje de texto entrante. */
export function cuerpoTextoEntrante(opts: {
  phoneNumberId: string;
  clienteWa: string;
  texto: string;
  messageId: string;
}): unknown {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: opts.phoneNumberId },
              messages: [
                {
                  from: opts.clienteWa,
                  id: opts.messageId,
                  type: "text",
                  text: { body: opts.texto },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
