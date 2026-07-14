import type { HorarioDia, Service, Tenant } from "../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// Tenant de EVALS (ángulo 4 de TESTING.md). A diferencia de los fixtures de
// `test/helpers`, este lleva una base de conocimiento COMPLETA (tarifas de
// lavado, tabla de parabrisas, FAQ) porque las evals miden la CALIDAD de las
// respuestas del agente (¿cotiza bien? ¿usa el precio del prompt?), no solo la
// mecánica. Los montos de abajo son los que afirman las transcripciones.
//
// Abre TODOS los días 07:00–18:00 a propósito: así "mañana"/"pasado mañana"
// siempre tienen espacios y los casos de agenda no se vuelven inestables por
// caer en un domingo cerrado (esto es un fixture de prueba, no producción).
// ─────────────────────────────────────────────────────────────────────────────

const ABIERTO: HorarioDia = { abre: "07:00", cierra: "18:00" };

const HORARIO_TODOS_LOS_DIAS: Record<number, HorarioDia> = {
  0: ABIERTO,
  1: ABIERTO,
  2: ABIERTO,
  3: ABIERTO,
  4: ABIERTO,
  5: ABIERTO,
  6: ABIERTO,
};

const SERVICIOS: Service[] = [
  // Lavados: por orden de llegada, NO se agendan.
  { id: "lavado_sencillo", nombre: "Lavado sencillo", precio: 5000, duracionMin: 30, agendable: false },
  // Pulidos: SÍ se agendan (requieren cita).
  {
    id: "pulido_parabrisas",
    nombre: "Pulido de parabrisas",
    precioNota: "según vehículo (ver tabla de parabrisas)",
    duracionMin: 60,
    agendable: true,
  },
  { id: "pulido_focos", nombre: "Pulido de focos", precioVariable: true, duracionMin: 45, agendable: true },
];

export function crearTenantEval(): Tenant {
  return {
    id: "tenant-eval",
    nombre: "Lavacar Rosales",
    phoneNumberId: "eval-000",
    timezone: "America/Costa_Rica",
    moneda: "₡",
    ubicacion: "San José centro, 200m sur del parque central",
    horario: HORARIO_TODOS_LOS_DIAS,
    intervaloAgendaMin: 60,
    servicios: SERVICIOS,
    kb: {
      faq: [
        { pregunta: "¿Aceptan tarjeta?", respuesta: "Por ahora solo SINPE Móvil y efectivo." },
        { pregunta: "¿Cuánto dura un pulido de parabrisas?", respuesta: "Alrededor de 1 hora." },
      ],
      datos: ["Somos un lavacar familiar con más de 10 años en San José."],
      politicas: ["Si el parabrisas ya tiene rajaduras, el pulido puede extender el daño; se revisa antes de empezar."],
      tarifas: [
        "Lavado sencillo sedán: ₡5.000",
        "Lavado sencillo SUV/camioneta: ₡7.000",
        "Lavado con cera sedán: ₡9.000",
        "Lavado con cera SUV/camioneta: ₡12.000",
      ],
      parabrisas: [
        "Pulido de parabrisas sedán: ₡15.000",
        "Pulido de parabrisas SUV/camioneta: ₡20.000",
        "Repelente de agua (NO es pulido, solo hace resbalar el agua): ₡8.000",
      ],
    },
    bloqueos: [],
    plan: "pro",
  };
}
