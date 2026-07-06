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
      name: "ofrecer_horarios",
      description:
        "Muestra al cliente los horarios libres de un PULIDO como una LISTA TOCABLE de WhatsApp (en vez de escribirlos en texto). Usala cuando ya tengas claro el servicio y la fecha y quieras que el cliente elija la hora con un toque. El cliente responderá tocando una opción. Si hay muchos horarios, pasá la franja ('mañana' o 'tarde') para que la lista sea corta; si aún no sabés la franja, preguntásela antes.",
      parameters: {
        type: "object",
        properties: {
          fecha: { type: "string", description: "Fecha a mostrar en formato YYYY-MM-DD." },
          servicioId: { type: "string", description: "id del servicio con pulido a agendar." },
          franja: {
            type: "string",
            enum: ["mañana", "tarde", "todos"],
            description: "Filtra los horarios: 'mañana' (antes de mediodía), 'tarde' (mediodía en adelante) o 'todos'. Por defecto 'todos'.",
          },
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
          precio: {
            type: "number",
            description:
              "Precio cotizado en colones (ej: 15000), tomado de la tabla de parabrisas según el vehículo. Para pulido de focos (se cotiza en persona) omitir.",
          },
        },
        required: ["nombre", "servicioId", "fecha", "hora"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "consultar_mi_cita",
      description:
        "Devuelve las citas de PULIDO activas (futuras) del cliente con el que estás chateando, identificadas por su número de WhatsApp. Usala cuando el cliente pregunte '¿cuándo es mi cita?' o antes de reprogramar/cancelar para saber cuál es.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "reprogramar_cita",
      description:
        "Cambia la fecha y/u hora de una cita YA agendada del cliente. Llamar SOLO tras confirmar el nuevo horario con el cliente y que esté disponible. Si el cliente tiene varias citas activas, pasá el citaId para indicar cuál (obtenelo con consultar_mi_cita).",
      parameters: {
        type: "object",
        properties: {
          fecha: { type: "string", description: "Nueva fecha en formato YYYY-MM-DD." },
          hora: { type: "string", description: "Nueva hora en formato HH:mm (24h)." },
          citaId: {
            type: "string",
            description: "id de la cita a mover (solo necesario si el cliente tiene más de una cita activa).",
          },
        },
        required: ["fecha", "hora"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancelar_cita",
      description:
        "Cancela una cita YA agendada del cliente. Llamar SOLO tras confirmar con el cliente que quiere cancelar. Si el cliente tiene varias citas activas, pasá el citaId (obtenelo con consultar_mi_cita).",
      parameters: {
        type: "object",
        properties: {
          citaId: {
            type: "string",
            description: "id de la cita a cancelar (solo necesario si el cliente tiene más de una cita activa).",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escalar_a_humano",
      description:
        "Pasa la conversación a una persona del equipo cuando NO podés resolver lo que el cliente necesita: una pregunta SOBRE EL NEGOCIO que no está en tu información, un reclamo, un caso especial, o algo que requiere a un encargado. NO la uses para pedidos FUERA del lavacar (esos se responden con amabilidad, sin escalar) ni cuando SÍ tenés la respuesta.",
      parameters: {
        type: "object",
        properties: {
          motivo: {
            type: "string",
            description: "Una frase breve con lo que el cliente necesita, para que el operador entre en contexto.",
          },
        },
        required: ["motivo"],
        additionalProperties: false,
      },
    },
  },
];
