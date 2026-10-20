import type { Tenant } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG DE SELYON — el primer negocio del SaaS (nuestra propia empresa de software,
// usada para probar el motor genérico multi-mercado, B7). Los tenants viven en la base
// (ver tenantStore); este objeto es la FUENTE DEL SEED (scripts/seedTenants.ts) y el
// FALLBACK de emergencia del store si la base aún no está sembrada o no responde.
//
// Es un STARTER: el contenido (servicios, secciones, instrucciones) se afina desde el
// panel ("Mi negocio" → "Perfil del negocio" + "Base de conocimiento"). El prompt se
// arma genéricamente desde estos campos (ver src/agent/systemPrompt.ts): no hay nada
// hardcodeado de un rubro puntual.
// ─────────────────────────────────────────────────────────────────────────────

const horarioLaboral = { abre: "08:00", cierra: "18:00" };
const cerrado = { abre: null, cierra: null };

const selyon: Tenant = {
  id: "selyon",
  nombre: "Selyon",
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "NUMERO_DE_PRUEBA",
  accessToken: undefined,
  // Hash de la contraseña del panel. NUNCA se commitea: se lee de una variable de
  // entorno. Generá el hash con: npx tsx scripts/hashPassword.ts "TU_CLAVE" y ponelo
  // en .env como PANEL_PASSWORD_HASH_SELYON.
  panelPasswordHash: process.env.PANEL_PASSWORD_HASH_SELYON,
  timezone: "America/Costa_Rica",
  moneda: "₡",
  ubicacion: "100% remoto (Costa Rica). Reuniones por videollamada; atendemos toda la región.",

  // Perfil del negocio (B7): con esto el system prompt arma la persona del bot.
  tipoNegocio: "una empresa de soluciones de software y automatización con IA",
  pais: "Costa Rica",
  registro: "vos",
  tono: "cercano, claro y profesional",
  formasPago: "Transferencia bancaria y factura electrónica",
  instrucciones: [
    "Sos el primer contacto de Selyon por WhatsApp. Tu objetivo es entender qué problema o idea quiere resolver el cliente con software, y ofrecerle agendar una reunión de diagnóstico gratuita.",
    "NO des precios ni plazos exactos por chat: dependen del alcance y se definen en la reunión. Si insisten, explicá con amabilidad que por eso es la reunión de diagnóstico (gratis y sin compromiso).",
    "Si preguntan algo muy técnico, comercial grande (contratos, licitaciones) o algo que no podés resolver, usá escalar_a_humano.",
    "Sé concreto y cálido; no prometas nada que no esté en tu información.",
  ].join("\n"),

  // Granularidad de las horas de INICIO de cita (no la duración).
  intervaloAgendaMin: 30,

  // Lunes a viernes 8am–6pm; fines de semana cerrado.
  horario: {
    0: cerrado,
    1: horarioLaboral,
    2: horarioLaboral,
    3: horarioLaboral,
    4: horarioLaboral,
    5: horarioLaboral,
    6: cerrado,
  },

  // Servicios agendables: reuniones. El resto de la info va en la base de conocimiento.
  servicios: [
    {
      id: "reunion-diagnostico",
      nombre: "Reunión de diagnóstico",
      precioNota: "Gratis · 30 min por videollamada",
      duracionMin: 30,
      agendable: true,
      descripcion: "Charla inicial para entender tu necesidad y ver cómo te podemos ayudar. Sin costo ni compromiso.",
    },
    {
      id: "demo",
      nombre: "Demo de producto",
      precioNota: "Gratis · 30 min por videollamada",
      duracionMin: 30,
      agendable: true,
      descripcion: "Te mostramos en vivo una solución similar a lo que necesitás (bot de WhatsApp, panel, automatización).",
    },
  ],

  kb: {
    faq: [
      {
        pregunta: "¿Cuánto cuesta un proyecto?",
        respuesta:
          "Depende del alcance. Lo definimos en una reunión de diagnóstico gratuita y te pasamos una propuesta con precio y plazo.",
      },
      { pregunta: "¿Hacen apps móviles?", respuesta: "Sí, desarrollamos software web y móvil a la medida." },
      {
        pregunta: "¿Dónde están ubicados?",
        respuesta: "Somos un equipo remoto en Costa Rica y trabajamos con clientes de toda la región.",
      },
      {
        pregunta: "¿Qué necesito para empezar?",
        respuesta: "Solo contarnos qué querés resolver. Agendamos una reunión de diagnóstico gratis y de ahí salimos con un plan.",
      },
    ],
    datos: [
      "Trabajamos 100% remoto; las reuniones son por videollamada (Google Meet).",
      "La reunión de diagnóstico es gratuita y sin compromiso.",
      "Atendemos clientes en Costa Rica y el resto de la región.",
    ],
    politicas: [
      "No damos precios ni plazos exactos por chat: se definen tras la reunión de diagnóstico.",
      "La primera reunión (diagnóstico) siempre es gratis.",
    ],
    secciones: [
      {
        id: "que-hacemos",
        titulo: "Qué hacemos",
        items: [
          "Desarrollo de software a medida (web y móvil).",
          "Automatización de procesos y agentes/chatbots con IA (como este mismo bot).",
          "Integraciones: WhatsApp, pagos, calendarios, CRMs y más.",
          "Consultoría de producto y acompañamiento técnico.",
        ],
      },
    ],
  },

  bloqueos: [],
  // Selyon atiende como un solo recurso (una agenda de reuniones): sin equipo cargado,
  // la disponibilidad se comporta igual que antes de ALTO-07.
  empleados: [],

  // Grandfathering (C4.3): nace en "pro" para no gatear features durante las pruebas.
  plan: "pro",
};

// Antes acá vivía la config de Lavacar Rosales (primer piloto). Con el pivote a Selyon
// (B7) el fallback/seed pasa a ser nuestra propia empresa. Este objeto es la fuente del
// seed (scripts/seedTenants.ts) y el FALLBACK de emergencia del store.
export const TENANT_FALLBACK_SELYON: Tenant = selyon;
