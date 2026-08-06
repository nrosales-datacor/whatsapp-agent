import type { HorarioDia, Service, Tenant } from "../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// Tenant de EVALS (ángulo 4 de TESTING.md), modelado sobre SELYON — el tenant
// real del motor genérico (B7). A diferencia de los fixtures de `test/helpers`,
// este lleva el perfil de negocio y la base de conocimiento COMPLETOS, porque las
// evals miden la CALIDAD de las respuestas (¿respeta la política de no dar
// precios? ¿elige el servicio correcto? ¿escala en vez de improvisar?), no solo
// la mecánica.
//
// Diferencias deliberadas con `src/config/tenants.ts` (el Selyon de producción):
//
//  1. Abre TODOS los días 08:00–18:00. El Selyon real cierra sábado y domingo; con
//     ese horario, un caso de agenda que diga "mañana" se vuelve inestable según el
//     día en que corran las evals (a veces cae en un día cerrado y no hay espacios).
//     Es un fixture de prueba, no producción.
//  2. `crearTenantEval({ upsell: true })` activa un add-on (ofrecer la demo al
//     agendar el diagnóstico). El Selyon real no tiene add-ons configurados, pero la
//     regla de upsell del prompt (Carril D, 1.2) es nueva y no la cubre ningún test:
//     se evalúa con este interruptor, no contaminando los demás casos de agenda.
//
// El resto (tipoNegocio, registro, instrucciones, políticas) es fiel al tenant real:
// si el prompt de producción cambia de comportamiento, estas evals lo tienen que ver.
// ─────────────────────────────────────────────────────────────────────────────

const ABIERTO: HorarioDia = { abre: "08:00", cierra: "18:00" };

const HORARIO_TODOS_LOS_DIAS: Record<number, HorarioDia> = {
  0: ABIERTO,
  1: ABIERTO,
  2: ABIERTO,
  3: ABIERTO,
  4: ABIERTO,
  5: ABIERTO,
  6: ABIERTO,
};

interface OpcionesEval {
  /** Activa el add-on "Demo de producto" sobre la reunión de diagnóstico (upsell, 1.2). */
  upsell?: boolean;
}

function servicios(upsell: boolean): Service[] {
  return [
    {
      id: "reunion-diagnostico",
      nombre: "Reunión de diagnóstico",
      precioNota: "Gratis · 30 min por videollamada",
      duracionMin: 30,
      agendable: true,
      descripcion: "Charla inicial para entender tu necesidad y ver cómo te podemos ayudar. Sin costo ni compromiso.",
      ...(upsell ? { addonSugeridoId: "demo", addonActivo: true } : {}),
    },
    {
      id: "demo",
      nombre: "Demo de producto",
      precioNota: "Gratis · 30 min por videollamada",
      duracionMin: 30,
      agendable: true,
      descripcion:
        "Te mostramos en vivo una solución similar a lo que necesitás (bot de WhatsApp, panel, automatización).",
    },
  ];
}

export function crearTenantEval(opciones: OpcionesEval = {}): Tenant {
  return {
    id: "tenant-eval",
    nombre: "Selyon",
    phoneNumberId: "eval-000",
    timezone: "America/Costa_Rica",
    moneda: "₡",
    ubicacion: "100% remoto (Costa Rica). Reuniones por videollamada; atendemos toda la región.",

    // Perfil del negocio (B7): de acá sale la persona del bot.
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

    intervaloAgendaMin: 30,
    horario: HORARIO_TODOS_LOS_DIAS,
    servicios: servicios(opciones.upsell === true),

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
          respuesta:
            "Solo contarnos qué querés resolver. Agendamos una reunión de diagnóstico gratis y de ahí salimos con un plan.",
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
    empleados: [],
    // Pro: habilita las reglas de upsell y rescate en el prompt/tools (Fase 1).
    plan: "pro",
  };
}
