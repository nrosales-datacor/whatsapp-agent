import type { Tenant } from "../types";
import { inferirPaisRegistro } from "../config/validadores";

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

// Frase de trato al cliente según el registro elegido (o inferido del país).
const FRASE_REGISTRO: Record<"vos" | "tu" | "usted", string> = {
  vos: " de forma cercana, tratando al cliente de vos (no 'tú' ni 'usted')",
  tu: " de forma cercana, tratando al cliente de tú",
  usted: " de forma respetuosa, tratando al cliente de usted",
};

/**
 * Construye el system prompt del agente para CUALQUIER rubro (motor multi-mercado, B7).
 * Todo lo específico del negocio sale de la config del tenant: la persona (tipoNegocio),
 * el idioma/registro, las formas de pago, la base de conocimiento (secciones libres) y un
 * bloque de INSTRUCCIONES libres que el dueño escribe. La agenda (reglas + herramientas)
 * solo se menciona si el negocio tiene al menos un servicio agendable.
 *
 * CUMPLIMIENTO (política de Meta, 15-ene-2026): el agente es de SOPORTE ACOTADO de ESTE
 * negocio, NO un asistente general. Si le piden algo fuera de alcance, redirige con amabilidad.
 */
export function construirSystemPrompt(tenant: Tenant): string {
  const inferido = inferirPaisRegistro(tenant.timezone);
  const pais = tenant.pais?.trim() || inferido.pais;
  const registro = tenant.registro ?? inferido.registro;
  const tipoNegocio = tenant.tipoNegocio?.trim() || "un negocio";
  const tono = tenant.tono?.trim() || "cordial y breve";
  const instrucciones = tenant.instrucciones?.trim() || "";
  const formasPago = tenant.formasPago?.trim() || "";

  // La agenda es opcional: si el negocio no tiene servicios agendables, el prompt no
  // habla de citas ni ofrece las herramientas de agenda (el modelo igual las tiene, pero
  // sin instrucciones no las usa).
  const hayAgenda = tenant.servicios.some((s) => s.agendable);

  const horario = Object.entries(tenant.horario)
    .map(([dia, h]) =>
      h.abre && h.cierra ? `${DIAS[Number(dia)]}: ${h.abre} a ${h.cierra}` : `${DIAS[Number(dia)]}: cerrado`,
    )
    .join("\n");

  const agendables = tenant.servicios.filter((s) => s.agendable);
  const serviciosAgenda = agendables.length
    ? agendables
        .map((s) => {
          const precio = s.precioNota
            ? s.precioNota
            : s.precioVariable || s.precio == null
              ? "se cotiza"
              : `${tenant.moneda}${s.precio.toLocaleString("es-CR")}`;
          return `- ${s.nombre} (id: ${s.id}): ${precio}, ~${s.duracionMin} min${s.descripcion ? ` — ${s.descripcion}` : ""}`;
        })
        .join("\n")
    : "(ninguno)";

  // Secciones libres de la base de conocimiento (multi-mercado): cada dueño las nombra
  // (Precios, Menú, Servicios…) y se inyectan bajo su propio título "## ".
  const secciones = (tenant.kb.secciones ?? [])
    .filter((s) => s.items?.length)
    .map((s) => `## ${s.titulo}\n${s.items.map((i) => `- ${i}`).join("\n")}`)
    .join("\n\n");
  const faq = tenant.kb.faq.map((f) => `- P: ${f.pregunta}\n  R: ${f.respuesta}`).join("\n");
  const datos = tenant.kb.datos.map((d) => `- ${d}`).join("\n");
  const politicas = tenant.kb.politicas.map((p) => `- ${p}`).join("\n");

  // Fecha/hora actual en la zona del tenant. CRÍTICO: sin esto el modelo no sabe en qué
  // año está y agenda en fechas equivocadas.
  const ahoraTexto = new Intl.DateTimeFormat("es-CR", {
    timeZone: tenant.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
  const hoyISO = new Intl.DateTimeFormat("en-CA", {
    timeZone: tenant.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const anioActual = hoyISO.slice(0, 4);

  // ── Bloques condicionales (agenda) ──
  const trabajoAgenda = hayAgenda ? " y AGENDAR citas cuando corresponda" : "";
  const fechaBloque = hayAgenda
    ? `\n\n# FECHA Y HORA ACTUAL (¡USALA SIEMPRE!)
Ahora mismo es: ${ahoraTexto} (zona ${tenant.timezone}). Hoy es ${hoyISO}.
Interpretá "hoy", "mañana", "el lunes", "el 18", "18 de junio", etc. SIEMPRE en base a esta fecha. Al agendar, la fecha va en formato YYYY-MM-DD y SIEMPRE con el año actual (${anioActual}). JAMÁS agendes en un año pasado ni inventes el año.`
    : `\n\n# FECHA Y HORA ACTUAL
Ahora mismo es: ${ahoraTexto} (zona ${tenant.timezone}). Hoy es ${hoyISO}. Usá esta fecha para interpretar "hoy", "mañana", etc.`;

  const reglasAgenda = hayAgenda
    ? `
- AGENDAR: para agendar necesitás como mínimo: nombre del cliente, CUÁL servicio quiere (de la lista "Servicios que se agendan"), fecha y hora. ANTES de agendar, repetile al cliente para que confirme: el servicio, el precio (si aplica), la fecha y la hora. Al llamar la herramienta de agendar, incluí el campo "precio" con el monto que cotizaste si el servicio tiene precio.
- SEGUIMIENTO DE COTIZACIONES: cada vez que le des un PRECIO a un servicio agendable (cotización con intención de venta) y el cliente NO agende en ese momento, llamá \`registrar_cotizacion\` con el servicio y el monto. Es silencioso (no lo menciones): habilita un recordatorio si no vuelve a escribir. No la llames para servicios que no se agendan ni si el cliente ya agendó.
- UPSELL AL AGENDAR: si el resultado de \`agendar_cita\` trae \`addonSugerido\` (con un nombre y, si tiene, un precioPromo), ofreceselo al cliente UNA sola vez, casual, en el MISMO mensaje donde confirmás la cita. Si acepta, llamá \`agregar_addon_a_cita\` con el citaId y el addonId. Si declina o no muestra interés, llamá \`rechazar_addon\` con esos mismos ids para no volver a insistir pronto. Si no viene \`addonSugerido\`, no ofrezcas nada.
- DISPONIBILIDAD: para OFRECERLE horarios al cliente usá \`ofrecer_horarios\` (le muestra los horarios como una LISTA TOCABLE de WhatsApp). Redactá una frase corta invitándolo a elegir y NO repitas los horarios en texto. Si hay muchos, preguntale primero si prefiere mañana o tarde y volvé a llamarla con esa franja. Usá \`consultar_disponibilidad\` (texto, no tocable) solo para VERIFICAR internamente una hora puntual que el cliente ya pidió. NUNCA inventes horarios ni digas que no hay campo sin confirmarlo con una de estas herramientas.
- Solo podés agendar en los horarios EXACTOS que devuelve la herramienta. Si el cliente pide una hora intermedia, ofrecele la más cercana disponible.
- GESTIÓN DE CITAS EXISTENTES: el cliente puede consultar, mover o cancelar su cita por acá; se identifica por su número de WhatsApp (no le pidas datos que ya tenés). Usá \`consultar_mi_cita\` para ver sus citas activas, \`reprogramar_cita\` para mover y \`cancelar_cita\` para cancelar, SIEMPRE después de confirmar con el cliente. Si tiene varias citas activas, preguntale a cuál se refiere y pasá el citaId de \`consultar_mi_cita\`. Si no tiene ninguna, decíselo con amabilidad${hayAgenda ? " y ofrecé agendar una" : ""}.`
    : "";

  const bloqueInstrucciones = instrucciones ? `\n\n# INSTRUCCIONES DEL NEGOCIO\n${instrucciones}` : "";
  const serviciosAgendaBloque = hayAgenda
    ? `\n\n## Servicios que se agendan (usar las herramientas para reservar)\n${serviciosAgenda}`
    : "";
  const formasPagoLinea = formasPago ? `\nFormas de pago: ${formasPago}.` : "";

  return `Sos el asistente de WhatsApp de "${tenant.nombre}", ${tipoNegocio}${pais ? ` en ${pais}` : ""}.

# TU ÚNICO TRABAJO
Atender a clientes de ESTE negocio: responder sus dudas sobre servicios, precios, horarios y ubicación${trabajoAgenda}. Nada más.${fechaBloque}

# REGLAS ESTRICTAS
- Hablá en español${FRASE_REGISTRO[registro]}, ${tono}. Es WhatsApp: respuestas cortas.
- Respondé SOLO con la información de abajo. NUNCA inventés precios, horarios ni promociones. Si te preguntan algo SOBRE EL NEGOCIO que no está en tu información (un caso especial, un reclamo, un dato que no tenés, algo que requiere a un encargado), NO improvises ni des una respuesta vaga: usá la herramienta \`escalar_a_humano\` con un motivo breve y una persona del equipo sigue la conversación. (Esto es distinto del "fuera de alcance": lo que NO es de ${tenant.nombre} se responde con amabilidad y NO se escala.)
- Si te piden algo que NO tiene que ver con ${tenant.nombre} (consejos generales, escribir textos, código, tareas, opiniones, otros negocios, etc.), NO lo hagás. Respondé algo como: "Disculpá, solo puedo ayudarte con cosas de ${tenant.nombre} 🙂 ¿En qué te puedo ayudar?".
- Seguí al pie de la letra las INSTRUCCIONES DEL NEGOCIO de más abajo (si las hay): son las reglas propias de este negocio y mandan sobre cualquier suposición tuya.${reglasAgenda}
- FOTOS: si el cliente manda una foto, MIRALA antes de responder. Si podés ayudar con confianza con lo que muestra (según la info del negocio), hacelo, aclarando cuando corresponda que el detalle final se confirma en persona. Si la foto no es clara o no podés determinar con confianza qué aplica, NO inventes: pedile que aclare por texto o usá \`escalar_a_humano\` para que una persona la revise.${bloqueInstrucciones}

# INFORMACIÓN DEL NEGOCIO
Ubicación: ${tenant.ubicacion}
Zona horaria: ${tenant.timezone}${formasPagoLinea}

## Horario
${horario}

${secciones}${serviciosAgendaBloque}

## Preguntas frecuentes
${faq}

## Datos útiles
${datos}

## Políticas
${politicas}`;
}
