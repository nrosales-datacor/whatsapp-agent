import type { ChatCompletionTool } from "openai/resources/chat/completions";

// ─────────────────────────────────────────────────────────────────────────────
// Herramientas del agente (OpenAI function calling).
// Aplican SOLO a servicios marcados como agendables. Los servicios no agendables no
// usan estas herramientas. La ejecución vive en runAgent.ts. Las descripciones son
// genéricas (multi-mercado): el detalle de cada negocio lo pone el system prompt.
// ─────────────────────────────────────────────────────────────────────────────

export const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "consultar_disponibilidad",
      description:
        "Devuelve los espacios libres para agendar un servicio en una fecha. Solo para servicios agendables.",
      parameters: {
        type: "object",
        properties: {
          fecha: { type: "string", description: "Fecha a consultar en formato YYYY-MM-DD." },
          servicioId: { type: "string", description: "id del servicio agendable a consultar." },
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
        "Muestra al cliente los horarios libres de un servicio como una LISTA TOCABLE de WhatsApp (en vez de escribirlos en texto). Usala cuando ya tengas claro el servicio y la fecha y quieras que el cliente elija la hora con un toque. El cliente responderá tocando una opción. Si hay muchos horarios, pasá la franja ('mañana' o 'tarde') para que la lista sea corta; si aún no sabés la franja, preguntásela antes.",
      parameters: {
        type: "object",
        properties: {
          fecha: { type: "string", description: "Fecha a mostrar en formato YYYY-MM-DD." },
          servicioId: { type: "string", description: "id del servicio agendable a mostrar." },
          franja: {
            type: "string",
            enum: ["mañana", "tarde", "todos"],
            description: "Filtra los horarios: 'mañana' (antes de mediodía), 'tarde' (mediodía en adelante) o 'todos'. Por defecto 'todos'.",
          },
          empleadoId: {
            type: "string",
            description:
              "id de la persona con la que el cliente quiere atenderse. Omitir si le da igual o si el negocio no tiene equipo: en ese caso se muestran los horarios de todo el equipo.",
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
      name: "ofrecer_empleados",
      description:
        "Muestra al cliente, como LISTA TOCABLE de WhatsApp, quiénes pueden atenderlo para un servicio (más la opción 'Cualquiera'). Usala SOLO si el negocio tiene equipo y el cliente todavía no dijo con quién quiere atenderse. Si el cliente ya nombró a alguien, o dijo que le da igual, NO la llames: pasá directo a ofrecer_horarios. Devuelve ok:false si el negocio no tiene equipo cargado.",
      parameters: {
        type: "object",
        properties: {
          servicioId: { type: "string", description: "id del servicio agendable elegido." },
        },
        required: ["servicioId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agendar_cita",
      description:
        "Crea una cita confirmada de un servicio agendable. Llamar SOLO tras confirmar los datos con el cliente y verificar disponibilidad.",
      parameters: {
        type: "object",
        properties: {
          nombre: { type: "string", description: "Nombre del cliente (máx. 80 caracteres)." },
          servicioId: { type: "string", description: "id del servicio agendable elegido." },
          fecha: { type: "string", description: "Fecha en formato YYYY-MM-DD." },
          hora: { type: "string", description: "Hora en formato HH:mm (24h)." },
          empleadoId: {
            type: "string",
            description:
              "id de la persona que atiende, si el cliente eligió una. Omitir si le da igual: el sistema le asigna solo a alguien que esté libre.",
          },
          placa: { type: "string", description: "Dato identificador opcional del cliente (ej: placa del vehículo). Omitir si no aplica." },
          precio: {
            type: "number",
            description:
              "Solo para servicios de precio VARIABLE: el monto cotizado en la moneda del negocio (ej: 15000). Si el servicio tiene precio fijo, el sistema usa el del catálogo y este valor se ignora. Omitir si se cotiza en persona.",
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
        "Devuelve las citas activas (futuras) del cliente con el que estás chateando, identificadas por su número de WhatsApp. Usala cuando el cliente pregunte '¿cuándo es mi cita?' o antes de reprogramar/cancelar para saber cuál es.",
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
      name: "registrar_cotizacion",
      description:
        "Registra que le diste un PRECIO a un servicio agendable con intención de venta pero el cliente NO agendó cita en el momento. Habilita un seguimiento automático más tarde si no vuelve a escribir. Llamala SIEMPRE que cotices un servicio agendable y el cliente no cierre la cita ahí mismo. No la uses para servicios que no se agendan ni si ya agendó.",
      parameters: {
        type: "object",
        properties: {
          servicioId: { type: "string", description: "id del servicio agendable cotizado." },
          monto: { type: "number", description: "Monto cotizado en la moneda del negocio (el mismo que le dijiste al cliente)." },
        },
        required: ["servicioId", "monto"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agregar_addon_a_cita",
      description:
        "Agrega el add-on sugerido a una cita ya agendada, cuando el cliente ACEPTA la oferta de upsell que le hiciste (en el mismo mensaje o en uno posterior). El addonId está en la lista de servicios del prompt (y en addonSugerido de agendar_cita). Si no tenés el citaId a mano, omitilo: el sistema usa la cita activa del cliente que lleva ese add-on.",
      parameters: {
        type: "object",
        properties: {
          citaId: {
            type: "string",
            description: "id de la cita a la que se agrega el add-on. Opcional: omitilo si no lo tenés exacto (NO lo inventes).",
          },
          addonId: { type: "string", description: "id del add-on (addonSugerido.addonId, o el addonId de la lista de servicios)." },
        },
        required: ["addonId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rechazar_addon",
      description:
        "Registra que el cliente NO quiso el add-on que le ofreciste (dijo que no, o no mostró interés). Llamala para no volver a insistir con lo mismo pronto. Mismo criterio de ids que agregar_addon_a_cita: el citaId es opcional.",
      parameters: {
        type: "object",
        properties: {
          citaId: {
            type: "string",
            description: "id de la cita cuya oferta de add-on se rechazó. Opcional: omitilo si no lo tenés exacto (NO lo inventes).",
          },
          addonId: { type: "string", description: "id del add-on rechazado (addonSugerido.addonId, o el de la lista de servicios)." },
        },
        required: ["addonId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escalar_a_humano",
      description:
        "Pasa la conversación a una persona del equipo cuando NO podés resolver lo que el cliente necesita: una pregunta SOBRE EL NEGOCIO que no está en tu información, un reclamo, un caso especial, o algo que requiere a un encargado. NO la uses para pedidos FUERA del negocio (esos se responden con amabilidad, sin escalar) ni cuando SÍ tenés la respuesta.",
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
