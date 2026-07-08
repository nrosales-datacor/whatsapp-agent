import type { Tenant } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG DE LAVACAR ROSALES — los tenants ahora viven en la base (ver tenantStore).
// Este objeto es la FUENTE DEL SEED (scripts/seedTenants.ts) y el FALLBACK de
// emergencia del store. Sigue siendo el lugar donde se editan las reglas del negocio.
//
// REGLA DE NEGOCIO IMPORTANTE:
//   • Los LAVADOS son por ORDEN DE LLEGADA (sin cita). Sus precios viven en
//     kb.tarifas y el agente solo los informa.
//   • Los servicios de PARABRISAS sin pulido (lavado+repelente, solo repelente,
//     sellado completo) también son por orden de llegada; sus precios están en
//     kb.parabrisas y el agente solo los informa.
//   • Solo los servicios CON PULIDO se AGENDAN (cita cada 1:30). Tienen precio
//     FIJO por vehículo (kb.parabrisas); el pulido de focos sí se cotiza. Esos
//     son los únicos servicios "agendables".
//   • El repelente/sellado NO es pulido: aclararlo siempre (ver systemPrompt).
// ─────────────────────────────────────────────────────────────────────────────

const horarioTodosLosDias = { abre: "06:00", cierra: "18:00" };

const rosales: Tenant = {
  id: "lavacar-rosales",
  nombre: "Lavacar Rosales",
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "NUMERO_DE_PRUEBA",
  accessToken: undefined,
  // Hash de la contraseña del panel. NUNCA se commitea: se lee de una variable de
  // entorno. Generá el hash con: npx tsx scripts/hashPassword.ts "TU_CLAVE" y ponelo
  // en .env como PANEL_PASSWORD_HASH_ROSALES.
  panelPasswordHash: process.env.PANEL_PASSWORD_HASH_ROSALES,
  timezone: "America/Costa_Rica",
  moneda: "₡",
  ubicacion:
    "San José, Calle 4 entre Avenidas 6 y 8; de Diario Extra 200 metros al sur. En Waze aparecemos como 'Lavacar Rosales'.",
  // Granularidad de las horas de INICIO de cita (no la duración). Con 30 min el
  // cliente puede empezar a las 9:00, 9:30, 10:00, etc. La duración real de cada
  // servicio (90 min) la pone duracionMin y evita que se solapen las citas.
  intervaloAgendaMin: 30,

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

  // SOLO los servicios que se agendan (los que llevan pulido). El resto va en kb.
  // El precio de los paquetes de parabrisas es FIJO por vehículo (ver kb.parabrisas);
  // por eso usan precioNota en vez de "se cotiza".
  servicios: [
    {
      id: "lavado_pulido_sellador",
      nombre: "Lavado + pulido de parabrisas + repelente y sellador",
      precioVariable: true,
      precioNota: "según vehículo (ver tabla de parabrisas)",
      duracionMin: 90,
      agendable: true,
      descripcion:
        "El servicio más completo: lavado con cera en húmedo + pulido del parabrisas (quita gota seca y manchas) + sellado + repelente. Solo parabrisas delantero. Requiere cita.",
    },
    {
      id: "pulido_sellador",
      nombre: "Pulido de parabrisas + repelente y sellador (sin lavado)",
      precioVariable: true,
      precioNota: "según vehículo (ver tabla de parabrisas)",
      duracionMin: 90,
      agendable: true,
      descripcion:
        "Pulido del parabrisas (quita gota seca, manchas y opacidad) + sellado + repelente, sin lavar el carro. Solo parabrisas delantero. Requiere cita.",
    },
    {
      id: "pulido_focos",
      nombre: "Pulido de focos",
      precioVariable: true,
      precioNota: "se cotiza según la opacidad del foco",
      duracionMin: 90,
      agendable: true,
      descripcion: "El precio se cotiza según la opacidad del foco. Requiere cita.",
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

    // Servicios de parabrisas. Precio FIJO por vehículo. El "lavado" incluido es
    // lavado completo con cera en húmedo. El pulido es SOLO del parabrisas delantero
    // y requiere cita; el resto (lavado+repelente, solo repelente) es por orden de llegada.
    parabrisas: [
      "Estos precios tratan SOLO el parabrisas delantero. El 'lavado' incluido es lavado completo con cera en húmedo.",
      "Sedán → Lavado+repelente: ₡10.000 | Lavado+pulido+repelente y sellador (con cita): ₡18.000 | Pulido+repelente y sellador, sin lavado (con cita): ₡15.000 | Solo repelente y sellador, sin lavado y SIN pulido: ₡5.000.",
      "SUV → Lavado+repelente: ₡11.000 | Lavado+pulido+repelente y sellador (con cita): ₡20.000 | Pulido+repelente y sellador, sin lavado (con cita): ₡15.000 | Solo repelente y sellador, sin pulido: ₡5.000.",
      "Camioneta (Montero, Fortuner) → Lavado+repelente: ₡12.000 | Lavado+pulido+repelente y sellador (con cita): ₡21.000 | Pulido+repelente y sellador, sin lavado (con cita): ₡15.000 | Solo repelente y sellador, sin pulido: ₡5.000.",
      "Camioneta grande (Hilux) → Lavado+repelente: ₡13.000 | Lavado+pulido+repelente y sellador (con cita): ₡22.000 | Pulido+repelente y sellador, sin lavado (con cita): ₡15.000 | Solo repelente y sellador, sin pulido: ₡5.000.",
      "Buseta → Lavado+repelente: ₡14.000 | Lavado+pulido+repelente y sellador (con cita): ₡23.000 | Pulido+repelente y sellador, sin lavado (con cita): ₡17.000 | Solo repelente y sellador, sin pulido: ₡7.000.",
      "Camión → Lavado+repelente: ₡16.000 | Lavado+pulido+repelente y sellador (con cita): ₡25.000 | Pulido+repelente y sellador, sin lavado (con cita): ₡17.000 | Solo repelente y sellador, sin pulido: ₡7.000.",
      "SELLADO COMPLETO (repelente y sellador en TODOS los vidrios + retrovisores externos, sin lavado, SIN pulido): Sedán ₡8.000 | SUV ₡9.000 | Camioneta, camioneta grande, buseta y camión ₡10.000.",
      "Qué incluye — Lavado+repelente: lavado con cera en húmedo + repelente en el parabrisas (sin pulido).",
      "Qué incluye — Lavado+pulido+repelente y sellador: lavado con cera en húmedo + pulido del parabrisas (quita gota seca y manchas) + sellado + repelente. Es el más completo.",
      "Qué incluye — Pulido+repelente y sellador (sin lavado): pulido del parabrisas + sellado + repelente, sin lavar el carro.",
      "Qué incluye — Solo repelente y sellador (sin lavado): tratamiento rápido del parabrisas para repeler el agua. NO incluye pulido. Recompra cada 3–4 meses.",
      "Qué incluye — Sellado completo (sin lavado): repelente y sellador en todos los vidrios y espejos. NO incluye pulido. Recompra cada 3–4 meses.",
    ],

    faq: [
      { pregunta: "¿Hay dónde sentarse mientras lavan mi carro?", respuesta: "Sí, hay un espacio para sentarse y esperar." },
      { pregunta: "¿Puedo dejar el carro y volver más tarde?", respuesta: "Claro, puede dejar el vehículo parqueado y hacer sus mandados mientras lo lavamos." },
      { pregunta: "¿Tienen algún beneficio para clientes frecuentes?", respuesta: "Sí: cada 10 lavados, el siguiente es gratis. Para conductores de Uber/plataformas, es cada 7 lavados." },
      { pregunta: "¿Lavan motos?", respuesta: "Sí, el lavado de moto cuesta ₡3.000." },
      { pregunta: "¿Necesito cita para lavar?", respuesta: "No, los lavados son por orden de llegada. Solo los servicios con pulido requieren cita." },
      {
        pregunta: "¿El tratamiento repelente incluye pulido?",
        respuesta:
          "No. El tratamiento repelente es solo para que el agua resbale y mejore la visibilidad; no quita manchas ni gota seca. El pulido es un servicio aparte, más completo, que sí remueve manchas y opacidad.",
      },
      {
        pregunta: "¿Cuánto dura el tratamiento repelente / cada cuánto se reactiva?",
        respuesta: "Alrededor de 3 a 4 meses, según el uso y el clima. Recomendamos reactivarlo cada 3–4 meses para mantener el efecto.",
      },
      {
        pregunta: "¿El pulido quita rayones o rajaduras?",
        respuesta:
          "No. El pulido quita manchas, gota seca y opacidad. Los rayones, rajaduras y picaduras son daños físicos del vidrio y no se trabajan.",
      },
      {
        pregunta: "¿El servicio cubre todos los vidrios?",
        respuesta:
          "El pulido es solo del parabrisas delantero. El repelente puede ser solo del parabrisas, o si querés cubrir todos los vidrios y los espejos, tenemos la opción de sellado completo.",
      },
      { pregunta: "¿Qué productos usan?", respuesta: "Productos profesionales de la más alta calidad (marca Meguiar's), para un buen resultado y durabilidad." },
      { pregunta: "¿Necesito cita para el pulido?", respuesta: "Sí, el pulido se trabaja con cita previa y toma alrededor de 1 a 1.5 horas. El lavado y el tratamiento de solo repelente son por orden de llegada." },
      {
        pregunta: "¿Hacen pulido de carrocería / de la pintura del carro?",
        respuesta:
          "Sí, hacemos pulido de carrocería. El precio depende del estado de la pintura, así que necesitás traer el carro para revisarlo en persona y darte el precio (no lo podemos cotizar por WhatsApp). Pasá en nuestro horario de atención y con gusto lo revisamos.",
      },
    ],
    datos: [
      "Los lavados se atienden por orden de llegada, sin cita.",
      "El lavado dura entre 45 minutos y 1 hora 30, según el tamaño y la suciedad del vehículo.",
      "Hay parqueo: puede dejar el carro mientras hace mandados.",
      "Aceptamos SINPE Móvil y efectivo (no tarjeta).",
      "El pulido aplica SOLO al parabrisas delantero.",
      "El sellado y repelente de agua NO es pulido: solo hace que el agua resbale para mejorar la visibilidad. No remueve manchas, gota seca ni opacidad.",
      "El pulido SÍ remueve: manchas de agua, gota seca, suciedad incrustada y opacidad superficial del vidrio.",
      "El pulido NO elimina: rayones, rajaduras, picaduras ni daños profundos del vidrio.",
      "El repelente/sellador se reactiva cada 3 a 4 meses para mantener el efecto.",
      "Usamos productos Meguiar's (alta calidad) para el pulido y el sellado.",
      "Pulido de carrocería (de la pintura): sí lo hacemos, pero el precio depende del estado del carro. Hay que llevar el vehículo para revisarlo EN PERSONA y dar el precio; NO se cotiza por WhatsApp ni se agenda en línea.",
    ],
    politicas: [
      "Los lavados no requieren cita: se atienden por orden de llegada.",
      "Los servicios CON pulido requieren cita; el lavado y el tratamiento de solo repelente son por orden de llegada.",
      "El tratamiento repelente/sellado NUNCA es pulido: hay que aclararle siempre al cliente que el repelente no quita manchas ni gota seca (para eso es el pulido).",
      "En parabrisas muy deteriorados (manchas muy profundas o desgaste severo) el pulido puede dar una mejora parcial; se evalúa y se conversa con el cliente antes de empezar.",
      "Si el vidrio ya tiene grietas, rajaduras o despostillados previos, el lavacar NO se hace responsable, porque el calor del pulido puede extender un daño existente. Se revisa el parabrisas junto con el cliente antes de empezar y el cliente decide si se continúa.",
    ],
  },

  bloqueos: [],
};

// Antes acá vivía el registro de tenants (TENANTS + tenantPorPhoneNumberId). Ahora
// los tenants se leen de la base a través del caché (src/config/tenantStore.ts).
// Este objeto queda como fuente del seed (scripts/seedTenants.ts) y como FALLBACK de
// emergencia del store si la base aún no está sembrada o no responde.
export const TENANT_FALLBACK_ROSALES: Tenant = rosales;
