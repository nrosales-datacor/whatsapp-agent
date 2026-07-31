import type { Repositorio } from "../types";
import { listarTenants } from "../config/tenantStore";

// ─────────────────────────────────────────────────────────────────────────────
// Datos de DEMO (desarrollo / diseño). Se cargan SOLO si la variable de entorno
// SEED_DEMO está seteada, y como el repo en memoria parte vacío, sirven para ver
// la bandeja y el dashboard con contenido realista al hacer el pase de diseño.
// NUNCA corre en producción (no se invoca sin SEED_DEMO) y no toca la base.
// ─────────────────────────────────────────────────────────────────────────────

// Ancla del "ahora" de la demo: relativa a Date.now() (no una fecha fija en el
// calendario). Una fecha fija se corre respecto al reloj real a medida que pasan
// los días — los mensajes "recientes" (haceMin) terminan pareciendo de hace
// semanas, lo que cierra la ventana de 24h (Carril D 0.3) en TODA la demo y
// rompe tanto el E2E del panel como cualquier demo de venta en vivo.
const BASE = Date.now();
const haceMin = (m: number) => new Date(BASE - m * 60_000).toISOString();
// Las fechas se resuelven en la ZONA DEL TENANT, no en UTC: la Agenda pinta el "hoy"
// del negocio, así que con toISOString() las citas de dia(0) caían en el día
// equivocado durante las horas en que UTC y Costa Rica no coinciden (y la vista de
// "Hoy" salía vacía). "en-CA" da directamente YYYY-MM-DD.
const TZ_DEMO = "America/Costa_Rica";
const dia = (diasAtras: number) =>
  new Date(BASE - diasAtras * 86_400_000).toLocaleDateString("en-CA", { timeZone: TZ_DEMO });

type Msg = { de: "cliente" | "bot" | "yo"; t: string; min: number };
type Conv = { wa: string; nombre: string; modo: "bot" | "humano"; leido: boolean; notas?: string; msgs: Msg[] };

const CONVERSACIONES: Conv[] = [
  {
    wa: "50687123344", nombre: "Diego Ramírez", modo: "bot", leido: true,
    notas: "Paciente frecuente. Sensibilidad al frío. Paga con SINPE.",
    msgs: [
      { de: "cliente", min: 95, t: "Buenas, ¿hacen limpieza dental?" },
      { de: "bot", min: 94, t: "¡Hola! 👋 Con gusto. La limpieza dental incluye remoción de sarro, pulido y aplicación de flúor. ¿Ya te habías atendido con nosotros antes?" },
      { de: "cliente", min: 92, t: "Sí, el año pasado" },
      { de: "bot", min: 91, t: "Perfecto. La limpieza dental sale ₡25.000 e incluye la valoración. Toma unos 45 minutos y se agenda con cita. ¿Te la agendo?" },
      { de: "cliente", min: 34, t: "Sí porfa, mañana temprano si se puede" },
      { de: "bot", min: 33, t: "¡Claro! Mañana tengo libre a las 8:00 a.m. o a las 9:30 a.m. ¿Cuál te queda mejor?" },
      { de: "cliente", min: 12, t: "A las 8 perfecto" },
      { de: "bot", min: 8, t: "Listo ✅ Te agendé la Limpieza dental para mañana a las 8:00 a.m. Llegá 10 minutos antes con tu cédula. ¡Nos vemos! 🦷" },
      { de: "cliente", min: 6, t: "Gracias!! ahí estaré" },
    ],
  },
  {
    wa: "50670112233", nombre: "Esteban Soto", modo: "humano", leido: false,
    notas: "Pidió factura electrónica. Cédula física 1-1234-5678.",
    msgs: [
      { de: "cliente", min: 60, t: "Buenas, necesito una factura electrónica de la limpieza de ayer" },
      { de: "bot", min: 59, t: "¡Hola! Con gusto le ayudo con eso. Permítame un momento que paso su caso con una persona del equipo. 🙌" },
      { de: "yo", min: 50, t: "Buenas don Esteban, claro que sí. ¿Me confirma el número de cédula para la factura?" },
      { de: "cliente", min: 14, t: "Es física, 1 1234 5678" },
    ],
  },
  {
    wa: "50671778899", nombre: "Karla Núñez", modo: "bot", leido: false,
    msgs: [{ de: "cliente", min: 22, t: "¿Están abiertos hoy?" }],
  },
  {
    wa: "50689998877", nombre: "Josué Vargas", modo: "bot", leido: false,
    msgs: [{ de: "cliente", min: 48, t: "Pura vida! ¿Trabajan con seguros médicos o convenios de empresa?" }],
  },
  {
    wa: "50688456677", nombre: "Gabriela Mora", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 80, t: "Buenas, ¿cuánto cuesta una resina?" },
      { de: "bot", min: 79, t: "¡Hola! La resina (calza estética) sale ₡35.000 por pieza e incluye anestesia local. Toma unos 40 minutos y se agenda con cita. 🦷" },
      { de: "cliente", min: 76, t: "Perfecto, ¡gracias!" },
      { de: "bot", min: 75, t: "¡Con gusto! Aquí le esperamos. 😊" },
    ],
  },
  {
    wa: "50689112266", nombre: "Valeria Solís", modo: "bot", leido: false,
    msgs: [{ de: "cliente", min: 110, t: "¿La limpieza incluye el flúor o es aparte?" }],
  },
  {
    wa: "50683221100", nombre: "Andrea Campos", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 165, t: "¿Hacen blanqueamiento? ¿cuánto sale?" },
      { de: "bot", min: 164, t: "Sí, hacemos blanqueamiento en consultorio. Sale ₡120.000 e incluye una limpieza previa (es requisito). Son 2 sesiones de 1 hora. ¿Le agendo la valoración?" },
      { de: "cliente", min: 161, t: "Sí, mañana puedo" },
      { de: "bot", min: 160, t: "¡Listo! La dejo agendada. Cualquier cambio me avisa. 👍" },
    ],
  },
  {
    wa: "50662445566", nombre: "Rafael Jiménez", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 235, t: "Buenas, ¿en qué consiste la profilaxis?" },
      { de: "bot", min: 234, t: "Buenas don Rafael. La profilaxis es la limpieza dental completa: remueve sarro y placa por encima y por debajo de la encía, pule las piezas y aplica flúor. Sale ₡25.000 y se recomienda cada 6 meses. ¿Desea que se la agende?" },
      { de: "cliente", min: 231, t: "Sí, y de paso una valoración por una muela que me molesta" },
      { de: "bot", min: 230, t: "¡Claro! Le agendo la limpieza y en la misma cita el doctor le revisa la muela. Le confirmo el horario. 🗓️" },
    ],
  },
  {
    wa: "50685334411", nombre: "Luis Brenes", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 325, t: "¿Atienden niños?" },
      { de: "bot", min: 324, t: "¡Sí! Atendemos desde los 3 años. La limpieza pediátrica sale ₡18.000 y dura unos 30 minutos. 🧒" },
    ],
  },
  {
    wa: "50688221144", nombre: "Natalia Rojas", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 455, t: "Necesito cambiar mi cita de limpieza para el jueves" },
      { de: "bot", min: 454, t: "¡Con gusto! El jueves tengo espacio a las 11:00 a.m. o a las 3:00 p.m. ¿Cuál prefiere?" },
      { de: "cliente", min: 452, t: "Las 3 está bien" },
      { de: "bot", min: 450, t: "Perfecto, su cita queda el jueves a las 3:00 p.m. ✅" },
    ],
  },
  {
    wa: "50661778822", nombre: "Mauricio Lépiz", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 565, t: "¿Cuánto cuesta sacar una muela del juicio?" },
      { de: "bot", min: 564, t: "La extracción de muela del juicio sale ₡85.000 e incluye anestesia y la valoración con radiografía. Se agenda con cita y dura alrededor de 1 hora. ¿Le agendo?" },
      { de: "cliente", min: 561, t: "Sí dale" },
      { de: "bot", min: 560, t: "¡Agendado! Le confirmo el horario por aquí. 🦷" },
    ],
  },
  {
    wa: "50683009988", nombre: "Roberto Mena", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 810, t: "¿Precio de la valoración?" },
      { de: "bot", min: 800, t: "La valoración sale ₡15.000 e incluye el diagnóstico y el plan de tratamiento. Si se hace un tratamiento el mismo día, se le abona. 👍" },
    ],
  },
  {
    wa: "50687220033", nombre: "Adriana Solís", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 990, t: "¿Tienen parqueo?" },
      { de: "bot", min: 980, t: "¡Sí! Tenemos parqueo propio sin costo para pacientes. 🅿️" },
    ],
  },
  {
    wa: "50684556677", nombre: "Pedro Alfaro", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 1710, t: "¿Hacen radiografías?" },
      { de: "bot", min: 1700, t: "¡Sí! Tenemos radiografía digital en el consultorio. La periapical sale ₡8.000 y la panorámica ₡25.000. 👍" },
    ],
  },
  {
    wa: "50687665544", nombre: "Sofía Quesada", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 1810, t: "¿Hacen brackets?" },
      { de: "bot", min: 1800, t: "Sí hacemos ortodoncia, pero el precio depende de cada caso. Hay que valorar la mordida y tomar radiografías en consulta para cotizarlo (no por WhatsApp). ¿Le agendo la valoración de ortodoncia? 🦷" },
    ],
  },
  {
    wa: "50661334477", nombre: "Fernando Ulate", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 2050, t: "Muchas gracias, quedé muy contento con la limpieza!" },
      { de: "bot", min: 2040, t: "¡Mil gracias don Fernando! 🙌 Le esperamos en su próximo control." },
    ],
  },
];

type Reserva = {
  wa: string;
  nombre: string;
  servicioId: string;
  fecha: string;
  hora: string;
  /** Referencia libre de la cita (placa, expediente…). Omitir si el rubro no la usa. */
  placa?: string;
  precio: number;
  origen?: "bot" | "manual";
  /** Estado final a aplicar tras crearla (ya pasó la fecha). undefined = queda "agendada". */
  resultado?: "completada" | "no_show";
  /** Upsell (Carril D, 1.2): add-on ACEPTADO al agendar, para las tarjetas de ticket promedio. */
  addon?: { servicioId: string; precio: number };
};

const CITAS: Reserva[] = [
  // HOY: la Agenda abre en el día de hoy, así que necesita citas o se ve el estado vacío.
  { wa: "50662445566", nombre: "Rafael Jiménez", servicioId: "limpieza_dental", fecha: dia(0), hora: "09:30", precio: 25000 },
  { wa: "50689443322", nombre: "Marcela Ríos", servicioId: "valoracion", fecha: dia(0), hora: "11:00", precio: 15000 },
  { wa: "50687001122", nombre: "Andrés Cordero", servicioId: "resina", fecha: dia(0), hora: "14:30", precio: 35000 },
  { wa: "50687123344", nombre: "Diego Ramírez", servicioId: "limpieza_dental", fecha: dia(-1), hora: "08:00", precio: 25000, resultado: "completada", addon: { servicioId: "fluor", precio: 8000 } },
  { wa: "50662445566", nombre: "Rafael Jiménez", servicioId: "limpieza_dental", fecha: dia(1), hora: "09:30", precio: 25000, addon: { servicioId: "fluor", precio: 8000 } },
  { wa: "50683221100", nombre: "Andrea Campos", servicioId: "blanqueamiento", fecha: dia(2), hora: "08:00", precio: 120000 },
  { wa: "50661778822", nombre: "Mauricio Lépiz", servicioId: "extraccion", fecha: dia(3), hora: "14:30", precio: 85000 },
  { wa: "50688777001", nombre: "Tatiana Vega", servicioId: "limpieza_dental", fecha: dia(4), hora: "08:00", precio: 25000 },
  { wa: "50687001122", nombre: "Andrés Cordero", servicioId: "resina", fecha: dia(5), hora: "09:30", precio: 35000 },
  { wa: "50689443322", nombre: "Marcela Ríos", servicioId: "valoracion", fecha: dia(2), hora: "14:30", precio: 15000 },
  { wa: "50688456677", nombre: "Gabriela Mora", servicioId: "resina", fecha: dia(6), hora: "10:00", precio: 35000, origen: "manual" },
  { wa: "50688221144", nombre: "Natalia Rojas", servicioId: "limpieza_dental", fecha: dia(7), hora: "11:00", precio: 25000 },
  { wa: "50670112233", nombre: "Esteban Soto", servicioId: "limpieza_dental", fecha: dia(8), hora: "16:00", precio: 25000 },
  { wa: "50687123344", nombre: "Diego Ramírez", servicioId: "valoracion", fecha: dia(20), hora: "10:00", precio: 15000 },
  { wa: "50664556677", nombre: "Pablo Arce", servicioId: "limpieza_dental", fecha: dia(-2), hora: "09:00", precio: 25000, resultado: "no_show" },
];

// Rescate de cotizaciones abandonadas (Carril D, 1.1): la tarjeta "₡ recuperados"
// del dashboard es la demo de venta de esta feature, así que el seed necesita
// cotizaciones en distintos estados (no solo "pendiente"). registrarCotizacion()
// del repo en memoria devuelve el objeto VIVO (no una copia) — mutarlo acá simula
// el paso del tiempo (toques ya enviados) sin esperar a que corra la mini-cola
// real (que solo existe con DB, ver src/rescate/worker.ts).
const COTIZACIONES_DEMO = [
  { wa: "50699001122", servicioId: "blanqueamiento", monto: 120000, resultado: "recuperada" as const },
  { wa: "50699001133", servicioId: "limpieza_dental", monto: 25000, resultado: "recuperada" as const },
  { wa: "50699001144", servicioId: "extraccion", monto: 85000, resultado: "toque1" as const },
  { wa: "50699001155", servicioId: "resina", monto: 35000, resultado: "pendiente" as const },
];

// Motor de reseñas completo (Carril D, 1.3): sentimiento a aplicar a algunas de las
// citas de CITAS (por índice), simulando seguimientos post-servicio YA respondidos —
// así el contador "Solicitudes de reseña enviadas" y la tarjeta "Reputación" del
// dashboard tienen datos reales en la demo (el envío real solo corre con DB, ver
// reminders/scheduler.ts).
// ⚠️ Los índices siguen el ORDEN de CITAS: si agregás o movés una cita, actualizalos.
const SEGUIMIENTOS_DEMO: { citaIdx: number; sentimiento: "positivo" | "neutral" | "negativo" }[] = [
  { citaIdx: 3, sentimiento: "positivo" }, // Diego Ramírez (completada)
  { citaIdx: 5, sentimiento: "positivo" }, // Andrea Campos
  { citaIdx: 6, sentimiento: "neutral" }, // Mauricio Lépiz
  { citaIdx: 14, sentimiento: "negativo" }, // Pablo Arce (no_show)
];

// Snapshots de reputación (Carril D, 1.3-c, Places API): 6 días de histórico con el
// rating subiendo de a poco, para que el gráfico de evolución tenga algo que mostrar
// sin esperar al job real (que solo corre con GOOGLE_PLACES_API_KEY + DB).
const REPUTACION_DEMO = [
  { diasAtras: 5, rating: 4.3, totalResenas: 41 },
  { diasAtras: 4, rating: 4.3, totalResenas: 42 },
  { diasAtras: 3, rating: 4.4, totalResenas: 44 },
  { diasAtras: 2, rating: 4.5, totalResenas: 46 },
  { diasAtras: 1, rating: 4.5, totalResenas: 47 },
  { diasAtras: 0, rating: 4.6, totalResenas: 49 },
];

// Perfil del NEGOCIO de la demo: una clínica dental ficticia. El tenant real (Selyon,
// nuestra propia empresa) no sirve de escaparate porque sus servicios son reuniones de
// software, y la ficha/agenda/"Mi negocio" mostrarían un rubro distinto al de las
// conversaciones sembradas. Se aplica MUTANDO el objeto vivo del caché de tenants —
// mismo truco que ya usa este archivo con las cotizaciones — porque
// actualizarConfigTenant() exige base de datos y la demo corre en memoria.
// SOLO ocurre bajo SEED_DEMO: producción nunca invoca seedDemo().
const NEGOCIO_DEMO = {
  nombre: "Clínica Dental Aurora",
  tipoNegocio: "una clínica dental",
  ubicacion: "San José, Costa Rica",
  formasPago: "Efectivo, tarjeta y SINPE Móvil",
  servicios: [
    { id: "limpieza_dental", nombre: "Limpieza dental", precio: 25000, duracionMin: 45, agendable: true, descripcion: "Remoción de sarro, pulido y aplicación de flúor.", addonSugeridoId: "fluor", addonPrecioPromo: 8000, addonActivo: true },
    { id: "valoracion", nombre: "Valoración", precio: 15000, duracionMin: 30, agendable: true, descripcion: "Diagnóstico y plan de tratamiento. Se abona si el tratamiento se hace el mismo día." },
    { id: "resina", nombre: "Resina (calza estética)", precio: 35000, duracionMin: 40, agendable: true, descripcion: "Calza del color del diente. Incluye anestesia local." },
    { id: "blanqueamiento", nombre: "Blanqueamiento", precio: 120000, duracionMin: 60, agendable: true, descripcion: "En consultorio, 2 sesiones. Requiere limpieza previa." },
    { id: "extraccion", nombre: "Extracción de muela del juicio", precio: 85000, duracionMin: 60, agendable: true, descripcion: "Incluye anestesia y radiografía de valoración." },
    { id: "fluor", nombre: "Aplicación de flúor", precio: 8000, duracionMin: 15, descripcion: "Complemento de la limpieza. Se ofrece como add-on al agendar." },
  ],
};

/** Convierte al tenant de la demo en la clínica dental ficticia (solo en memoria). */
function aplicarNegocioDemo(): void {
  const t = listarTenants()[0];
  if (!t) return;
  t.nombre = NEGOCIO_DEMO.nombre;
  t.tipoNegocio = NEGOCIO_DEMO.tipoNegocio;
  t.ubicacion = NEGOCIO_DEMO.ubicacion;
  t.formasPago = NEGOCIO_DEMO.formasPago;
  t.servicios = NEGOCIO_DEMO.servicios;
}

export async function seedDemo(repo: Repositorio): Promise<void> {
  aplicarNegocioDemo();
  const tid = listarTenants()[0]?.id ?? "selyon";
  for (const c of CONVERSACIONES) {
    const conv = await repo.obtenerOConversacion(tid, c.wa);
    for (const m of c.msgs) {
      await repo.guardarMensaje(conv.id, {
        rol: m.de === "cliente" ? "user" : "assistant",
        contenido: m.t,
        creadoEn: haceMin(m.min),
        porHumano: m.de === "yo",
      });
    }
    if (c.modo === "humano") await repo.setModoConversacion(tid, conv.id, "humano");
    if (c.notas) await repo.guardarNotas(tid, conv.id, c.notas);
    if (c.leido) await repo.marcarLeidas(tid, conv.id);
  }
  const citasCreadas: { id: string }[] = [];
  for (const k of CITAS) {
    const cita = await repo.crearCita({
      tenantId: tid,
      clienteWa: k.wa,
      clienteNombre: k.nombre,
      servicioId: k.servicioId,
      fecha: k.fecha,
      hora: k.hora,
      placa: k.placa,
      precio: k.precio,
      origen: k.origen,
    });
    if (k.resultado === "completada") await repo.completarCita(tid, cita.id);
    if (k.resultado === "no_show") await repo.marcarNoShow(tid, cita.id);
    if (k.addon) await repo.agregarAddonACita(tid, cita.id, k.addon);
    citasCreadas.push(cita);
  }
  for (const s of SEGUIMIENTOS_DEMO) {
    const cita = citasCreadas[s.citaIdx];
    if (!cita) continue;
    await repo.crearSeguimiento(tid, cita.id);
    await repo.registrarRespuestaSeguimiento(cita.id, s.sentimiento, s.sentimiento === "positivo", "(demo)");
  }
  for (const s of REPUTACION_DEMO) {
    await repo.guardarSnapshotReputacion(tid, dia(s.diasAtras), s.rating, s.totalResenas);
  }
  // Upsell (Carril D, 1.2): un cliente que declinó el add-on, para que la tarjeta
  // "Tasa de aceptación" tenga un denominador real (no solo aceptados). Usa el wa de
  // Gabriela Mora (ya tiene conversación por CONVERSACIONES): registrarRechazoAddon
  // requiere que la conversación exista (no crea una nueva).
  await repo.registrarRechazoAddon(tid, "50688456677", "fluor");
  for (const c of COTIZACIONES_DEMO) {
    const cotiz = await repo.registrarCotizacion(tid, c.wa, c.servicioId, c.monto);
    if (!cotiz) continue;
    if (c.resultado === "toque1") {
      cotiz.estado = "toque1";
      cotiz.toque1En = haceMin(200);
    } else if (c.resultado === "recuperada") {
      cotiz.estado = "recuperada";
      cotiz.toque1En = haceMin(300);
      cotiz.montoRecuperado = c.monto;
    }
  }
  console.log(
    `[seed] ${CONVERSACIONES.length} conversaciones, ${CITAS.length} citas, ${COTIZACIONES_DEMO.length} cotizaciones, ` +
      `${SEGUIMIENTOS_DEMO.length} seguimientos y ${REPUTACION_DEMO.length} snapshots de reputación de demo cargados`,
  );
}
