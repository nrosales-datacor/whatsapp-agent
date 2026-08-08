import "../helpers/setupEnv"; // PRIMERO: fija OPENAI_API_KEY antes de importar el server
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { RepositorioEnMemoria } from "../../src/booking/inMemoryRepository";
import { ingerirEntrante, responderEntrante, type Pendiente } from "../../src/handleWebhook";
import { cargarTenants } from "../../src/config/tenantStore";
import { TENANT_FALLBACK_SELYON } from "../../src/config/tenants";
import type { Conversacion, HorarioDia, Tenant } from "../../src/types";
import { crearCita, crearTenant } from "../helpers/fixtures";
import {
  cuerpoTextoEntrante,
  desactivarMockWebhook,
  instalarMockWebhook,
} from "../helpers/webhookMock";

// ─────────────────────────────────────────────────────────────────────────────
// Ángulo 3 de TESTING.md — E2E del webhook IN-PROCESS (sin red). Repo en memoria +
// Graph API y OpenAI mockeados (ver test/helpers/webhookMock.ts). Se simula un
// entrante y se afirma la salida de responderEntrante: qué se le respondió al
// cliente, qué quedó en el repo, y si el agente se invocó o no.
//
// responderEntrante recibe el tenant DENTRO del Pendiente (no toca el tenantStore),
// así que lo armamos a mano con un tenant fixture. Solo el test de dedup ejerce la
// fase de ingesta (ingerirEntrante), que sí resuelve el tenant por phone_number_id.
// ─────────────────────────────────────────────────────────────────────────────

// Lavacar abierto TODOS los días (para que cualquier fecha futura tenga horarios).
const HORARIO_TODOS: Record<number, HorarioDia> = Object.fromEntries(
  Array.from({ length: 7 }, (_, d) => [d, { abre: "07:00", cierra: "17:00" }]),
);

function tenantDemo(overrides: Partial<Tenant> = {}): Tenant {
  return crearTenant({
    horario: HORARIO_TODOS,
    linkResenas: "https://g.page/r/lavacar-rosales",
    accessToken: "test-token", // sin esto, enviarTexto lanza antes del fetch (no hay token de Graph)
    ...overrides,
  });
}

const CLIENTE = "50688887777";

/** "YYYY-MM-DD" a `dias` de hoy (UTC), robusto ante el reloj real de la máquina. */
function fechaFutura(dias: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Crea la conversación en el repo y devuelve un snapshot fresco (con el modo pedido). */
async function nuevaConv(
  repo: RepositorioEnMemoria,
  tenant: Tenant,
  clienteWa = CLIENTE,
  modo: "bot" | "humano" = "bot",
): Promise<Conversacion> {
  const c = await repo.obtenerOConversacion(tenant.id, clienteWa);
  if (modo === "humano") await repo.setModoConversacion(tenant.id, c.id, "humano");
  return (await repo.obtenerConversacionPorId(tenant.id, c.id))!;
}

/** Arma un Pendiente de texto (o de respuesta interactiva) listo para responderEntrante. */
function pendienteTexto(
  tenant: Tenant,
  conv: Conversacion,
  opts: { texto: string; interactiveId?: string; primerContacto?: boolean; clienteWa?: string },
): Pendiente {
  return {
    clase: "texto",
    tenant,
    conv,
    primerContacto: opts.primerContacto ?? false,
    historialPrevio: [],
    entrante: {
      phoneNumberId: tenant.phoneNumberId,
      clienteWa: opts.clienteWa ?? CLIENTE,
      texto: opts.texto,
      esTexto: true,
      messageId: "wamid.in.txt",
      interactiveId: opts.interactiveId,
    },
  };
}

afterEach(() => desactivarMockWebhook());

// ── Acciones directas (NO pasan por el agente) ──

test("BAJA (comando exacto) marca opt-out y NO invoca al agente", async () => {
  const mock = instalarMockWebhook();
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant);

  await responderEntrante(pendienteTexto(tenant, conv, { texto: "BAJA" }), repo);

  const fresca = await repo.obtenerConversacionPorId(tenant.id, conv.id);
  assert.ok(fresca?.optOutEn, "debe quedar marcado el opt-out");
  assert.equal(mock.llamadasLLM(), 0, "opt-out no debe llamar a OpenAI");
  assert.equal(mock.enviados.length, 1);
  assert.match(mock.enviados[0].texto ?? "", /promociones/i);
});

test('"baja" dentro de una frase NO es opt-out (sin falso positivo): pasa al agente', async () => {
  const mock = instalarMockWebhook();
  mock.programarLLM({ texto: "Con gusto. ¿En qué te puedo ayudar?" });
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant);

  await responderEntrante(pendienteTexto(tenant, conv, { texto: "quiero darme de baja del estrés y lavar el carro" }), repo);

  const fresca = await repo.obtenerConversacionPorId(tenant.id, conv.id);
  assert.equal(fresca?.optOutEn ?? null, null, "no debe marcar opt-out por una palabra en la frase");
  assert.equal(mock.llamadasLLM(), 1, "debe pasar al agente");
  assert.equal(mock.enviados[0].texto, "Con gusto. ¿En qué te puedo ayudar?");
});

test("confirmación de cita por botón (C1.3) es acción directa: confirma sin agente", async () => {
  const mock = instalarMockWebhook();
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant);
  const cita = await repo.crearCita({ ...crearCita({ tenantId: tenant.id, clienteWa: CLIENTE, fecha: fechaFutura(3) }) });

  await responderEntrante(
    pendienteTexto(tenant, conv, { texto: "Confirmo mi cita ✅", interactiveId: `confirmar|${cita.id}` }),
    repo,
  );

  const [activa] = await repo.citasActivasCliente(tenant.id, CLIENTE, fechaFutura(0));
  assert.ok(activa.confirmadaEn, "la cita debe quedar confirmada");
  assert.equal(mock.llamadasLLM(), 0, "confirmar es acción directa, sin agente");
  assert.match(mock.enviados[0].texto ?? "", /confirmar/i);
});

test("post-servicio 'Todo bien' (C3.1) manda el link de reseñas, sin agente", async () => {
  const mock = instalarMockWebhook();
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant);

  await responderEntrante(
    pendienteTexto(tenant, conv, { texto: "Todo bien 👍", interactiveId: "postbien|cita-x" }),
    repo,
  );

  assert.equal(mock.llamadasLLM(), 0);
  assert.match(mock.enviados[0].texto ?? "", /g\.page\/r\/lavacar-rosales/, "debe incluir el link de reseñas");
});

test("post-servicio 'Tuve un problema' (C3.1) escala a humano, sin agente", async () => {
  const mock = instalarMockWebhook();
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant);

  await responderEntrante(
    pendienteTexto(tenant, conv, { texto: "Tuve un problema", interactiveId: "postmal|cita-x" }),
    repo,
  );

  assert.equal(await repo.obtenerModo(tenant.id, conv.id), "humano", "insatisfacción debe pasar a humano");
  assert.equal(mock.llamadasLLM(), 0);
  assert.match(mock.enviados[0].texto ?? "", /lamentamos/i);
});

test('pedir "agente" escala a humano por texto, sin invocar al agente', async () => {
  const mock = instalarMockWebhook();
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant);

  await responderEntrante(pendienteTexto(tenant, conv, { texto: "quiero hablar con un agente por favor" }), repo);

  assert.equal(await repo.obtenerModo(tenant.id, conv.id), "humano");
  assert.equal(mock.llamadasLLM(), 0, "la escotilla humana no pasa por el LLM");
  assert.match(mock.enviados[0].texto ?? "", /persona del equipo/i);
});

test("conversación en modo humano: el bot NO responde ni invoca al agente", async () => {
  const mock = instalarMockWebhook();
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant, CLIENTE, "humano");

  await responderEntrante(pendienteTexto(tenant, conv, { texto: "hola, una consulta" }), repo);

  assert.equal(mock.enviados.length, 0, "en modo humano el bot no le escribe al cliente");
  assert.equal(mock.llamadasLLM(), 0);
});

// ── Rutas del agente (LLM mockeado, determinista) ──

test("cotiza con el texto que redacta el agente (relay fiel) y guarda la respuesta", async () => {
  const mock = instalarMockWebhook();
  mock.programarLLM({ texto: "Un sedán básico cuesta ₡4.000 (incluye lavado + aspirado)." });
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant);

  await responderEntrante(pendienteTexto(tenant, conv, { texto: "¿cuánto vale lavar un sedán?" }), repo);

  assert.equal(mock.llamadasLLM(), 1);
  assert.equal(mock.enviados[0].texto, "Un sedán básico cuesta ₡4.000 (incluye lavado + aspirado).");
  const fresca = await repo.obtenerConversacionPorId(tenant.id, conv.id);
  const ult = fresca!.mensajes.at(-1)!;
  assert.equal(ult.rol, "assistant");
  assert.match(ult.contenido, /₡4\.000/);
});

test("cotiza una FOTO (visión, C1.5): descarga la imagen, la adjunta al LLM y la guarda", async () => {
  const mock = instalarMockWebhook();
  mock.programarLLM({ texto: "Por esa foto, el pulido de parabrisas de un sedán son ₡15.000." });
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant);
  // Simula la persistencia que hace la fase 1 para el mensaje de foto entrante.
  await repo.guardarMensaje(tenant.id, conv.id, {
    rol: "user",
    contenido: "[foto] ¿cuánto por pulir esto?",
    creadoEn: new Date().toISOString(),
    waMessageId: "wamid.img.1",
  });

  const pendiente: Pendiente = {
    clase: "imagen",
    tenant,
    conv,
    primerContacto: false,
    historialPrevio: [],
    entrante: {
      phoneNumberId: tenant.phoneNumberId,
      clienteWa: CLIENTE,
      texto: "",
      esTexto: false,
      messageId: "wamid.img.1",
      imagenId: "IMG1",
      imagenCaption: "¿cuánto por pulir esto?",
    },
  };
  await responderEntrante(pendiente, repo);

  // La foto se descargó y quedó adjunta al mensaje (para que el operador la vea).
  const fresca = await repo.obtenerConversacionPorId(tenant.id, conv.id);
  const msgFoto = fresca!.mensajes.find((m) => m.waMessageId === "wamid.img.1")!;
  assert.match(msgFoto.mediaUrl ?? "", /^data:image\/jpeg;base64,/);
  // La imagen viajó al LLM como contenido multimodal (image_url).
  const contenidoUser = mock.solicitudesLLM[0].messages.at(-1).content;
  assert.ok(Array.isArray(contenidoUser) && contenidoUser.some((p: any) => p.type === "image_url"));
  assert.equal(mock.enviados[0].texto, "Por esa foto, el pulido de parabrisas de un sedán son ₡15.000.");
});

test("agenda: el agente ofrece horarios como LISTA tocable (interactivo)", async () => {
  const mock = instalarMockWebhook();
  const fecha = fechaFutura(4);
  mock.programarLLM(
    { tool: "ofrecer_horarios", args: { fecha, servicioId: "pulido" } },
    { texto: "Tenemos estos horarios 👇 Elegí el que te sirva." },
  );
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant);

  await responderEntrante(pendienteTexto(tenant, conv, { texto: `quiero agendar un pulido para el ${fecha}` }), repo);

  assert.equal(mock.llamadasLLM(), 2, "una llamada para la tool, otra para el texto final");
  const env = mock.enviados[0];
  assert.equal(env.tipo, "interactive");
  assert.equal(env.interactive.type, "list");
  const filas = env.interactive.action.sections[0].rows;
  assert.ok(filas.some((f: any) => String(f.id).startsWith(`slot|${fecha}|`)), "las filas deben codificar los slots");
});

test("agenda: el tap en un horario (slot|…) crea la cita en el repo", async () => {
  const mock = instalarMockWebhook();
  const fecha = fechaFutura(4);
  mock.programarLLM(
    { tool: "agendar_cita", args: { servicioId: "pulido", fecha, hora: "09:00", nombre: "Juan Pérez" } },
    { texto: "¡Listo! Te agendé el pulido ✅" },
  );
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant);

  await responderEntrante(
    pendienteTexto(tenant, conv, {
      texto: `Quiero agendar para el ${fecha} a las 09:00.`,
      interactiveId: `slot|${fecha}|09:00`,
    }),
    repo,
  );

  const [cita] = await repo.citasActivasCliente(tenant.id, CLIENTE, fechaFutura(0));
  assert.ok(cita, "debe existir la cita creada");
  assert.equal(cita.fecha, fecha);
  assert.equal(cita.hora, "09:00");
  assert.equal(cita.servicioId, "pulido");
  assert.equal(mock.enviados.at(-1)!.texto, "¡Listo! Te agendé el pulido ✅");
});

test("reprograma por el bot y REINICIA los recordatorios de la cita", async () => {
  const mock = instalarMockWebhook();
  const fechaVieja = fechaFutura(5);
  const fechaNueva = fechaFutura(9);
  mock.programarLLM(
    { tool: "reprogramar_cita", args: { fecha: fechaNueva, hora: "10:00" } },
    { texto: "¡Listo! Reprogramé tu cita ✅" },
  );
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant);
  const cita = await repo.crearCita({
    tenantId: tenant.id,
    clienteWa: CLIENTE,
    clienteNombre: "Juan",
    servicioId: "pulido",
    fecha: fechaVieja,
    hora: "08:00",
    recordatorioDiaAntesEn: new Date().toISOString(), // ya se había mandado el recordatorio
  } as any);

  await responderEntrante(pendienteTexto(tenant, conv, { texto: "quiero reprogramar mi cita" }), repo);

  const [activa] = await repo.citasActivasCliente(tenant.id, CLIENTE, fechaFutura(0));
  assert.equal(activa.id, cita.id);
  assert.equal(activa.fecha, fechaNueva);
  assert.equal(activa.hora, "10:00");
  assert.equal(activa.recordatorioDiaAntesEn ?? null, null, "reprogramar debe reiniciar los recordatorios");
});

test("el agente pide escalar (escalar_a_humano): pasa a humano con el mensaje de escalada", async () => {
  const mock = instalarMockWebhook();
  mock.programarLLM({ escalar: "el cliente pide algo fuera de alcance" });
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant);

  await responderEntrante(pendienteTexto(tenant, conv, { texto: "necesito una factura timbrada especial" }), repo);

  assert.equal(await repo.obtenerModo(tenant.id, conv.id), "humano");
  assert.equal(mock.enviados.length, 1);
  assert.match(mock.enviados[0].texto ?? "", /una persona del equipo/i);
});

test("respeta la ventana humana: si un humano toma la conversación mientras el LLM piensa, se descarta la respuesta", async () => {
  const mock = instalarMockWebhook();
  mock.programarLLM({ texto: "Respuesta del bot que NO debe enviarse." });
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant); // snapshot en modo bot
  // Un humano toma la conversación DESPUÉS del snapshot (simula el traspaso durante el proceso).
  await repo.setModoConversacion(tenant.id, conv.id, "humano");

  await responderEntrante(pendienteTexto(tenant, conv, { texto: "una consulta" }), repo);

  assert.equal(mock.llamadasLLM(), 1, "el agente llegó a correr");
  assert.equal(mock.enviados.length, 0, "pero la respuesta se descarta: no se pisa al humano");
});

// ── E12: ubicación / documento / contacto / reacción ──

test("ubicación compartida: el texto sintético con las coordenadas llega al prompt del agente", async () => {
  const mock = instalarMockWebhook();
  mock.programarLLM({ texto: "Gracias, ya tengo tu ubicación. Te esperamos por ahí." });
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant);
  const textoUbicacion = "[ubicación compartida] lat: 9.9333, lon: -84.0833, nombre: Casa";

  await responderEntrante(pendienteTexto(tenant, conv, { texto: textoUbicacion }), repo);

  assert.equal(mock.llamadasLLM(), 1, "la ubicación debe fluir al agente como texto normal");
  const contenidoUser = mock.solicitudesLLM[0].messages.at(-1).content;
  const textoEnviado = typeof contenidoUser === "string" ? contenidoUser : JSON.stringify(contenidoUser);
  assert.match(textoEnviado, /lat: 9\.9333/);
  assert.match(textoEnviado, /lon: -84\.0833/);
  assert.equal(mock.enviados[0].texto, "Gracias, ya tengo tu ubicación. Te esperamos por ahí.");
});

test("documento recibido: mensaje específico al cliente (no el genérico) + push con el nombre del archivo", async () => {
  const mock = instalarMockWebhook();
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant);
  const logs: string[] = [];
  const logOriginal = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

  try {
    await responderEntrante(
      {
        clase: "documento",
        tenant,
        conv,
        entrante: {
          phoneNumberId: tenant.phoneNumberId,
          clienteWa: CLIENTE,
          texto: "",
          esTexto: false,
          messageId: "wamid.doc.1",
          documentoId: "doc-1",
          documentoNombre: "cedula.pdf",
        },
      },
      repo,
    );
  } finally {
    console.log = logOriginal;
  }

  assert.equal(mock.llamadasLLM(), 0, "un documento no debe invocar al agente");
  assert.equal(mock.enviados.length, 1);
  assert.match(mock.enviados[0].texto ?? "", /documento/i);
  assert.ok(!/stickers/i.test(mock.enviados[0].texto ?? ""), "no debe ser el mensaje genérico de stickers/video");
  assert.ok(logs.some((l) => l.includes("cedula.pdf")), "el push al operador debe mencionar el nombre del archivo");
});

test("contacto compartido: mensaje específico al cliente (no el genérico) + push con el nombre del contacto", async () => {
  const mock = instalarMockWebhook();
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant);
  const logs: string[] = [];
  const logOriginal = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

  try {
    await responderEntrante(
      {
        clase: "contacto",
        tenant,
        conv,
        entrante: {
          phoneNumberId: tenant.phoneNumberId,
          clienteWa: CLIENTE,
          texto: "",
          esTexto: false,
          messageId: "wamid.contact.1",
          contactoNombre: "María Pérez",
        },
      },
      repo,
    );
  } finally {
    console.log = logOriginal;
  }

  assert.equal(mock.llamadasLLM(), 0, "un contacto no debe invocar al agente");
  assert.equal(mock.enviados.length, 1);
  assert.match(mock.enviados[0].texto ?? "", /contacto/i);
  assert.ok(!/stickers/i.test(mock.enviados[0].texto ?? ""), "no debe ser el mensaje genérico de stickers/video");
  assert.ok(logs.some((l) => l.includes("María Pérez")), "el push al operador debe mencionar el nombre del contacto");
});

test("video/sticker (sin tipar): sigue cayendo en el genérico de 'no puedo ver stickers ni videos'", async () => {
  const mock = instalarMockWebhook();
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant);

  await responderEntrante(
    {
      clase: "no-texto",
      tenant,
      conv,
      entrante: {
        phoneNumberId: tenant.phoneNumberId,
        clienteWa: CLIENTE,
        texto: "",
        esTexto: false,
        messageId: "wamid.video.1",
      },
    },
    repo,
  );

  assert.equal(mock.llamadasLLM(), 0);
  assert.equal(mock.enviados.length, 1);
  assert.match(mock.enviados[0].texto ?? "", /stickers ni videos/i);
});

test("reacción (👍) se ignora por completo: no produce Pendiente (ni job, ni push, ni respuesta)", async () => {
  delete process.env.DATABASE_URL; // fuerza el fallback en memoria del tenantStore
  await cargarTenants();
  const pnid = TENANT_FALLBACK_SELYON.phoneNumberId;
  const repo = new RepositorioEnMemoria();
  const body = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: pnid },
              messages: [
                {
                  id: "wamid.reaction.1",
                  from: "50611110000",
                  type: "reaction",
                  reaction: { message_id: "wamid.out.1", emoji: "👍" },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const pendiente = await ingerirEntrante(body, repo);
  assert.equal(pendiente, null, "una reacción no debe producir ningún Pendiente (se ignora igual que un status)");
});

// ── E5-a: historial fresco (no el snapshot viejo de la ingesta) ──

test("E5-a: aunque el payload traiga un historialPrevio VIEJO (snapshot desactualizado), el agente ve la conversación completa", async () => {
  const mock = instalarMockWebhook();
  mock.programarLLM({ texto: "¡Listo! Te veo el viernes." });
  const repo = new RepositorioEnMemoria();
  const tenant = tenantDemo();
  const conv = await nuevaConv(repo, tenant);

  // Simula lo que hace la fase 1 (ingesta) para los 3 mensajes de una ráfaga: los 3
  // quedan persistidos en el repo (eso SIEMPRE pasa, sea cual sea el estado del job).
  await repo.guardarMensaje(tenant.id, conv.id, { rol: "user", contenido: "Hola", creadoEn: new Date().toISOString(), waMessageId: "wamid.1" });
  await repo.guardarMensaje(tenant.id, conv.id, {
    rol: "user",
    contenido: "quiero una cita",
    creadoEn: new Date().toISOString(),
    waMessageId: "wamid.2",
  });
  await repo.guardarMensaje(tenant.id, conv.id, {
    rol: "user",
    contenido: "para el viernes",
    creadoEn: new Date().toISOString(),
    waMessageId: "wamid.3",
  });

  // El Pendiente del 3er mensaje trae un snapshot VIEJO tomado antes de que llegara
  // el 2º mensaje (race real: dos webhooks casi simultáneos, el 2º lee la
  // conversación antes de que el 1º termine de guardar). Sin el fix (E5-a), el
  // agente respondería sin haber visto "quiero una cita".
  const pendiente: Pendiente = {
    clase: "texto",
    tenant,
    conv,
    primerContacto: false,
    historialPrevio: [{ rol: "user", contenido: "Hola", creadoEn: new Date().toISOString(), waMessageId: "wamid.1" }],
    entrante: {
      phoneNumberId: tenant.phoneNumberId,
      clienteWa: CLIENTE,
      texto: "para el viernes",
      esTexto: true,
      messageId: "wamid.3",
    },
  };

  await responderEntrante(pendiente, repo);

  assert.equal(mock.llamadasLLM(), 1);
  const mensajesPrompt = mock.solicitudesLLM[0].messages as Array<{ content: unknown }>;
  const contenidos = mensajesPrompt.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
  assert.ok(contenidos.some((c) => c.includes("quiero una cita")), "el historial fresco debe incluir el 2º mensaje, ausente del snapshot viejo");
  assert.ok(contenidos.some((c) => c.includes("Hola")), "el historial fresco debe incluir el 1º mensaje");
  assert.equal(contenidos.filter((c) => c.includes("para el viernes")).length, 1, "el 3er mensaje (turno actual) NO debe duplicarse en el historial");
});

// ── Fase de ingesta: dedup por wamid ──

test("dedup por wamid: reenviar el mismo mensaje no re-procesa (ingerirEntrante)", async () => {
  delete process.env.DATABASE_URL; // fuerza el fallback en memoria del tenantStore
  await cargarTenants();
  const pnid = TENANT_FALLBACK_SELYON.phoneNumberId;
  const repo = new RepositorioEnMemoria();
  const body = cuerpoTextoEntrante({ phoneNumberId: pnid, clienteWa: "50611110000", texto: "hola", messageId: "wamid.dup.1" });

  const p1 = await ingerirEntrante(body, repo);
  assert.ok(p1, "el primer mensaje produce un Pendiente");
  const p2 = await ingerirEntrante(body, repo);
  assert.equal(p2, null, "el reenvío del mismo wamid NO se re-procesa");
});
