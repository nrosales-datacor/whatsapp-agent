import type { Tenant } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRO DE TENANTS — Lavacar Rosales es el tenant #1.
//
// REGLA DE NEGOCIO IMPORTANTE:
//   • Los LAVADOS son por ORDEN DE LLEGADA (sin cita). Sus precios viven en
//     kb.tarifas y el agente solo los informa.
//   • Solo los PULIDOS se AGENDAN (cita cada 1:30) y su precio se cotiza por
//     vehículo. Esos son los únicos servicios "agendables".
// ─────────────────────────────────────────────────────────────────────────────

const horarioTodosLosDias = { abre: "06:00", cierra: "18:00" };

const rosales: Tenant = {
  id: "lavacar-rosales",
  nombre: "Lavacar Rosales",
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "NUMERO_DE_PRUEBA",
  accessToken: undefined,
  timezone: "America/Costa_Rica",
  moneda: "₡",
  ubicacion:
    "San José, Calle 4 entre Avenidas 6 y 8; de Diario Extra 200 metros al sur. En Waze aparecemos como 'Lavacar Rosales'.",
  // Solo aplica a pulidos (lo agendable). 90 min = 1:30.
  intervaloAgendaMin: 90,

  // Abierto todos los días, 6 am a 6 pm.
  horario: {
    0: horarioTodosLosDias,
    1: horarioTodosLosDias,
    2: horarioTodosLosDias,
    3: horarioTodosLosDias,
    4: horarioTodosLosDias,
    5: horarioTodosLosDias,
    6: horarioTodosLosDias,
  },

  // SOLO los servicios que se agendan (pulidos). El resto va en kb.tarifas.
  servicios: [
    {
      id: "pulido_parabrisas",
      nombre: "Pulido de parabrisas",
      precioVariable: true,
      duracionMin: 90,
      agendable: true,
      descripcion: "Se cotiza según el vehículo. Requiere cita.",
    },
    {
      id: "pulido_focos",
      nombre: "Pulido de focos",
      precioVariable: true,
      duracionMin: 90,
      agendable: true,
      descripcion: "Se cotiza según el vehículo. Requiere cita.",
    },
  ],

  kb: {
    // Precios de lavados (por orden de llegada). El agente cotiza desde acá.
    tarifas: [
      "El lavado incluye lavado + aspirado. Opciones: básico | con cera en húmedo | con cera en seco.",
      "Sedán: ₡4.000 básico · ₡5.000 con cera húmedo · ₡6.000 con cera seco.",
      "SUV: ₡5.000 básico · ₡6.000 con cera húmedo · ₡7.000 con cera seco.",
      "Camioneta (Montero, Fortuner o similar): ₡7.000 básico · ₡8.000 con cera húmedo · ₡9.000 con cera seco.",
      "Camioneta grande (tipo Hilux): ₡8.000 básico · ₡9.000 con cera húmedo · ₡10.000 con cera seco.",
      "Buseta: ₡9.000 básico · ₡10.000 con cera húmedo · ₡11.000 con cera seco.",
      "Camión: ₡11.000 básico · ₡12.000 con cera húmedo · ₡13.000 con cera seco.",
      "Moto: ₡3.000.",
      "Lavado de motor (parte superior): ₡6.000.",
      "Lavado de chasis: ₡6.000.",
    ],
    faq: [
      { pregunta: "¿Hay dónde sentarse mientras lavan mi carro?", respuesta: "Sí, hay un espacio para sentarse y esperar." },
      { pregunta: "¿Puedo dejar el carro y volver más tarde?", respuesta: "Claro, puede dejar el vehículo parqueado y hacer sus mandados mientras lo lavamos." },
      { pregunta: "¿Tienen algún beneficio para clientes frecuentes?", respuesta: "Sí: cada 10 lavados, el siguiente es gratis. Para conductores de Uber/plataformas, es cada 7 lavados." },
      { pregunta: "¿Lavan motos?", respuesta: "Sí, el lavado de moto cuesta ₡3.000." },
      { pregunta: "¿Necesito cita para lavar?", respuesta: "No, los lavados son por orden de llegada. Solo los pulidos requieren cita." },
    ],
    datos: [
      "Los lavados se atienden por orden de llegada, sin cita.",
      "El lavado dura entre 45 minutos y 1 hora 30, según el tamaño y la suciedad del vehículo.",
      "Hay parqueo: puede dejar el carro mientras hace mandados.",
      "Aceptamos SINPE Móvil y efectivo (no tarjeta).",
    ],
    politicas: [
      "Los lavados no requieren cita: se atienden por orden de llegada.",
      "Los pulidos requieren cita y el precio se cotiza según el vehículo (se puede hacer excepción si hay disponibilidad).",
    ],
  },
};

export const TENANTS: Tenant[] = [rosales];

/** Busca el tenant por el phone_number_id que viene en el webhook entrante. */
export function tenantPorPhoneNumberId(phoneNumberId: string): Tenant | undefined {
  return TENANTS.find((t) => t.phoneNumberId === phoneNumberId);
}
