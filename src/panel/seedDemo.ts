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
const dia = (diasAtras: number) => new Date(BASE - diasAtras * 86_400_000).toISOString().slice(0, 10);

type Msg = { de: "cliente" | "bot" | "yo"; t: string; min: number };
type Conv = { wa: string; nombre: string; modo: "bot" | "humano"; leido: boolean; notas?: string; msgs: Msg[] };

const CONVERSACIONES: Conv[] = [
  {
    wa: "50687123344", nombre: "Diego Ramírez", modo: "bot", leido: true,
    notas: "Cliente frecuente. Trae la Hilux. Paga con SINPE.",
    msgs: [
      { de: "cliente", min: 95, t: "Buenas, ¿hacen pulido de parabrisas?" },
      { de: "bot", min: 94, t: "¡Hola! 👋 Con gusto. Sí hacemos pulido de parabrisas: quita la gota seca, las manchas y la opacidad del vidrio. ¿Para qué vehículo sería?" },
      { de: "cliente", min: 92, t: "Una Hilux" },
      { de: "bot", min: 91, t: "Perfecto. Para una Hilux, el Lavado + pulido de parabrisas + repelente y sellador sale ₡22.000 e incluye lavado completo con cera en húmedo. El pulido lleva cita y toma de 1 a 1.5 horas. ¿Te lo agendo?" },
      { de: "cliente", min: 34, t: "Sí porfa, mañana temprano si se puede" },
      { de: "bot", min: 33, t: "¡Claro! Mañana tengo libre a las 8:00 a.m. o a las 9:30 a.m. ¿Cuál te queda mejor?" },
      { de: "cliente", min: 12, t: "A las 8 perfecto" },
      { de: "bot", min: 8, t: "Listo ✅ Te agendé el Lavado + pulido + repelente y sellador para mañana a las 8:00 a.m. en Lavacar Rosales. Cualquier cosa me escribís. ¡Nos vemos! 🚗" },
      { de: "cliente", min: 6, t: "Gracias!! ahí estaré" },
    ],
  },
  {
    wa: "50670112233", nombre: "Esteban Soto", modo: "humano", leido: false,
    notas: "Pidió factura electrónica. Cédula física 1-1234-5678.",
    msgs: [
      { de: "cliente", min: 60, t: "Buenas, necesito una factura electrónica del lavado de ayer" },
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
    msgs: [{ de: "cliente", min: 48, t: "Pura vida! Soy chofer de Uber, ¿tienen algún beneficio para los que lavamos seguido?" }],
  },
  {
    wa: "50688456677", nombre: "Gabriela Mora", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 80, t: "Buenas, ¿cuánto cuesta el lavado de una SUV?" },
      { de: "bot", min: 79, t: "¡Hola! El lavado de SUV: ₡5.000 básico, ₡6.000 con cera en húmedo y ₡7.000 con cera en seco. Incluye lavado + aspirado y es por orden de llegada, sin cita. 🚙" },
      { de: "cliente", min: 76, t: "Perfecto, ¡gracias!" },
      { de: "bot", min: 75, t: "¡Con gusto! Aquí le esperamos. 😊" },
    ],
  },
  {
    wa: "50689112266", nombre: "Valeria Solís", modo: "bot", leido: false,
    msgs: [{ de: "cliente", min: 110, t: "¿El repelente incluye el pulido o es aparte?" }],
  },
  {
    wa: "50683221100", nombre: "Andrea Campos", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 165, t: "¿Hacen pulido de focos? ¿cuánto sale?" },
      { de: "bot", min: 164, t: "Sí, hacemos pulido de focos. El precio se cotiza según la opacidad del foco, así que lo vemos en persona. Lleva cita y dura alrededor de 1 hora. ¿Le agendo una revisión?" },
      { de: "cliente", min: 161, t: "Sí, mañana puedo" },
      { de: "bot", min: 160, t: "¡Listo! La dejo agendada. Cualquier cambio me avisa. 👍" },
    ],
  },
  {
    wa: "50662445566", nombre: "Rafael Jiménez", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 235, t: "Buenas, ¿en qué consiste el sellado completo?" },
      { de: "bot", min: 234, t: "Buenas don Rafael. El sellado completo aplica repelente y sellador en TODOS los vidrios y los espejos externos (sin lavado y sin pulido). Para sedán sale ₡8.000 y se reactiva cada 3–4 meses. ¿Desea que se lo agende junto con un pulido?" },
      { de: "cliente", min: 231, t: "Mejor solo el pulido del parabrisas, ¿me lo agenda?" },
      { de: "bot", min: 230, t: "¡Claro! Pulido de parabrisas con cita. Lo agendo y le confirmo el horario. 🗓️" },
    ],
  },
  {
    wa: "50685334411", nombre: "Luis Brenes", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 325, t: "¿Lavan motos?" },
      { de: "bot", min: 324, t: "¡Sí! El lavado de moto sale ₡3.000 y es por orden de llegada. 🏍️" },
    ],
  },
  {
    wa: "50688221144", nombre: "Natalia Rojas", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 455, t: "Necesito cambiar mi cita de pulido para el jueves" },
      { de: "bot", min: 454, t: "¡Con gusto! El jueves tengo espacio a las 11:00 a.m. o a las 3:00 p.m. ¿Cuál prefiere?" },
      { de: "cliente", min: 452, t: "Las 3 está bien" },
      { de: "bot", min: 450, t: "Perfecto, su cita queda el jueves a las 3:00 p.m. ✅" },
    ],
  },
  {
    wa: "50661778822", nombre: "Mauricio Lépiz", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 565, t: "¿Cuánto el pulido de parabrisas sin lavado para un sedán?" },
      { de: "bot", min: 564, t: "Para sedán, el pulido + repelente y sellador sin lavado sale ₡15.000 (con cita, dura 1–1.5 h). ¿Le agendo?" },
      { de: "cliente", min: 561, t: "Sí dale" },
      { de: "bot", min: 560, t: "¡Agendado! Le confirmo el horario por aquí. 🚗" },
    ],
  },
  {
    wa: "50683009988", nombre: "Roberto Mena", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 810, t: "¿Precio del lavado de moto?" },
      { de: "bot", min: 800, t: "El lavado de moto sale ₡3.000, por orden de llegada. 🏍️" },
    ],
  },
  {
    wa: "50687220033", nombre: "Adriana Solís", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 990, t: "¿Tienen parqueo para dejar el carro?" },
      { de: "bot", min: 980, t: "¡Sí! Puede dejar el vehículo y hacer sus mandados mientras lo lavamos. 🅿️" },
    ],
  },
  {
    wa: "50684556677", nombre: "Pedro Alfaro", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 1710, t: "¿Lavan el chasis?" },
      { de: "bot", min: 1700, t: "¡Sí! El lavado de chasis sale ₡6.000 y es por orden de llegada. 👍" },
    ],
  },
  {
    wa: "50687665544", nombre: "Sofía Quesada", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 1810, t: "¿Hacen pulido de la pintura del carro?" },
      { de: "bot", min: 1800, t: "Sí hacemos pulido de carrocería, pero el precio depende del estado de la pintura. Hay que ver el carro en persona para cotizarlo (no por WhatsApp). Pase en nuestro horario y con gusto lo revisamos. 👨‍🔧" },
    ],
  },
  {
    wa: "50661334477", nombre: "Fernando Ulate", modo: "bot", leido: true,
    msgs: [
      { de: "cliente", min: 2050, t: "Muchas gracias, el carro quedó excelente!" },
      { de: "bot", min: 2040, t: "¡Mil gracias don Fernando! 🙌 Aquí le esperamos la próxima." },
    ],
  },
];

type Reserva = {
  wa: string;
  nombre: string;
  servicioId: string;
  fecha: string;
  hora: string;
  placa: string;
  precio: number;
  origen?: "bot" | "manual";
  /** Estado final a aplicar tras crearla (ya pasó la fecha). undefined = queda "agendada". */
  resultado?: "completada" | "no_show";
  /** Upsell (Carril D, 1.2): add-on ACEPTADO al agendar, para las tarjetas de ticket promedio. */
  addon?: { servicioId: string; precio: number };
};

const CITAS: Reserva[] = [
  { wa: "50687123344", nombre: "Diego Ramírez", servicioId: "lavado_pulido_sellador", fecha: dia(-1), hora: "08:00", placa: "C 162345", precio: 22000, resultado: "completada", addon: { servicioId: "pulido_focos", precio: 8000 } },
  { wa: "50662445566", nombre: "Rafael Jiménez", servicioId: "lavado_pulido_sellador", fecha: dia(1), hora: "09:30", placa: "BHL089", precio: 18000, addon: { servicioId: "pulido_focos", precio: 8000 } },
  { wa: "50683221100", nombre: "Andrea Campos", servicioId: "pulido_focos", fecha: dia(2), hora: "08:00", placa: "BMW234", precio: 12000 },
  { wa: "50661778822", nombre: "Mauricio Lépiz", servicioId: "pulido_sellador", fecha: dia(3), hora: "14:30", placa: "SJB1198", precio: 15000 },
  { wa: "50688777001", nombre: "Tatiana Vega", servicioId: "lavado_pulido_sellador", fecha: dia(4), hora: "08:00", placa: "CMP445", precio: 20000 },
  { wa: "50687001122", nombre: "Andrés Cordero", servicioId: "pulido_sellador", fecha: dia(5), hora: "09:30", placa: "BNK332", precio: 15000 },
  { wa: "50689443322", nombre: "Marcela Ríos", servicioId: "pulido_focos", fecha: dia(2), hora: "14:30", placa: "GBT810", precio: 10000 },
  { wa: "50688456677", nombre: "Gabriela Mora", servicioId: "lavado_pulido_sellador", fecha: dia(6), hora: "10:00", placa: "BST770", precio: 20000, origen: "manual" },
  { wa: "50688221144", nombre: "Natalia Rojas", servicioId: "lavado_pulido_sellador", fecha: dia(7), hora: "11:00", placa: "HJP620", precio: 21000 },
  { wa: "50670112233", nombre: "Esteban Soto", servicioId: "pulido_focos", fecha: dia(8), hora: "16:00", placa: "MGL047", precio: 12000 },
  { wa: "50687123344", nombre: "Diego Ramírez", servicioId: "pulido_sellador", fecha: dia(20), hora: "10:00", placa: "C 162345", precio: 15000 },
  { wa: "50664556677", nombre: "Pablo Arce", servicioId: "lavado_pulido_sellador", fecha: dia(-2), hora: "09:00", placa: "PJK330", precio: 22000, resultado: "no_show" },
];

// Rescate de cotizaciones abandonadas (Carril D, 1.1): la tarjeta "₡ recuperados"
// del dashboard es la demo de venta de esta feature, así que el seed necesita
// cotizaciones en distintos estados (no solo "pendiente"). registrarCotizacion()
// del repo en memoria devuelve el objeto VIVO (no una copia) — mutarlo acá simula
// el paso del tiempo (toques ya enviados) sin esperar a que corra la mini-cola
// real (que solo existe con DB, ver src/rescate/worker.ts).
const COTIZACIONES_DEMO = [
  { wa: "50699001122", servicioId: "pulido_sellador", monto: 15000, resultado: "recuperada" as const },
  { wa: "50699001133", servicioId: "lavado_pulido_sellador", monto: 20000, resultado: "recuperada" as const },
  { wa: "50699001144", servicioId: "pulido_focos", monto: 12000, resultado: "toque1" as const },
  { wa: "50699001155", servicioId: "pulido_sellador", monto: 15000, resultado: "pendiente" as const },
];

// Motor de reseñas completo (Carril D, 1.3): sentimiento a aplicar a algunas de las
// citas de CITAS (por índice), simulando seguimientos post-servicio YA respondidos —
// así el contador "Solicitudes de reseña enviadas" y la tarjeta "Reputación" del
// dashboard tienen datos reales en la demo (el envío real solo corre con DB, ver
// reminders/scheduler.ts).
const SEGUIMIENTOS_DEMO: { citaIdx: number; sentimiento: "positivo" | "neutral" | "negativo" }[] = [
  { citaIdx: 0, sentimiento: "positivo" }, // Diego Ramírez (completada)
  { citaIdx: 2, sentimiento: "positivo" }, // Andrea Campos
  { citaIdx: 3, sentimiento: "neutral" }, // Mauricio Lépiz
  { citaIdx: 11, sentimiento: "negativo" }, // Pablo Arce (no_show)
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

export async function seedDemo(repo: Repositorio): Promise<void> {
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
  await repo.registrarRechazoAddon(tid, "50688456677", "pulido_focos");
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
