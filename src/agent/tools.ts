import type { ChatCompletionTool } from "openai/resources/chat/completions";

// ─────────────────────────────────────────────────────────────────────────────
// Herramientas del agente (OpenAI function calling).
// Aplican SOLO a servicios agendables (pulidos). Los lavados son por orden de
// llegada y NO se agendan. La ejecución vive en runAgent.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "consultar_disponibilidad",
      description:
        "Devuelve los espacios libres para agendar un PULIDO en una fecha. Solo para servicios agendables (pulidos), no para lavados.",
      parameters: {
        type: "object",
        properties: {
          fecha: { type: "string", description: "Fecha a consultar en formato YYYY-MM-DD." },
          servicioId: { type: "string", description: "id del servicio con pulido (ej: 'lavado_pulido_sellador', 'pulido_sellador', 'pulido_focos')." },
        },
        required: ["fecha", "servicioId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agendar_cita",
      description:
        "Crea una cita de PULIDO confirmada. Llamar SOLO tras confirmar los datos con el cliente y verificar disponibilidad. No usar para lavados.",
      parameters: {
        type: "object",
        properties: {
          nombre: { type: "string", description: "Nombre del cliente." },
          servicioId: { type: "string", description: "id del pulido elegido." },
          fecha: { type: "string", description: "Fecha en formato YYYY-MM-DD." },
          hora: { type: "string", description: "Hora en formato HH:mm (24h)." },
          placa: { type: "string", description: "Placa del vehículo (opcional)." },
        },
        required: ["nombre", "servicioId", "fecha", "hora"],
        additionalProperties: false,
      },
    },
  },
];
