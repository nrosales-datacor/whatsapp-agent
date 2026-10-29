import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { waCampanias, waCampaniaEnvios } from "../../src/db/schema";
import { marcarEnviado, purgarEnviosFinalizados, quedanPendientes, reclamarEnvio } from "../../src/campaigns/cola";
import { elegirEsperaMs, esperaThrottleTenant, registrarEnvioTenant } from "../../src/campaigns/worker";
import type { EstadoCampania } from "../../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// Ángulo 5 (TESTING.md) — mini-cola de envíos de campaña (C3.2) contra Postgres
// efímero (PGlite). Mismo patrón de claim que wa_jobs, con el candado extra de
// que la CAMPAÑA padre siga 'enviando'. Se prueba el SQL real.
// ─────────────────────────────────────────────────────────────────────────────

const TENANT = "tenant-camp";
type Db = Awaited<ReturnType<typeof crearDbEfimera>>["db"];

async function crearCampania(db: Db, estado: EstadoCampania, tenantId: string = TENANT): Promise<string> {
  const [c] = await db
    .insert(waCampanias)
    .values({
      tenantId,
      nombre: "Promo lluvia",
      mensaje: "20% en pulido este mes",
      segmentoTipo: "todos",
      segmentoParametros: { tipo: "todos" },
      estado,
    })
    .returning({ id: waCampanias.id });
  return c.id;
}

async function sembrarEnvios(db: Db, campaniaId: string, n: number, tenantId: string = TENANT): Promise<void> {
  await db.insert(waCampaniaEnvios).values(
    Array.from({ length: n }, (_, i) => ({
      campaniaId,
      tenantId,
      clienteWa: `${tenantId}-${i}`,
      clienteNombre: `Cliente ${i}`,
    })),
  );
}

test("cada envío se reclama una sola vez: sin duplicados aunque se drene toda la cola", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const campaniaId = await crearCampania(db, "enviando");
    await sembrarEnvios(db, campaniaId, 5);

    const vistos: string[] = [];
    for (let i = 0; i < 10; i++) {
      const envio = await reclamarEnvio(db);
      if (!envio) break;
      vistos.push(envio.id);
      await marcarEnviado(db, envio.id);
    }

    assert.equal(vistos.length, 5, "se reclaman los 5 envíos");
    assert.equal(new Set(vistos).size, 5, "ninguno se reclamó dos veces");
    assert.equal(await reclamarEnvio(db), null, "no quedan envíos por reclamar");
    assert.equal(await quedanPendientes(db, campaniaId), false, "la campaña ya no tiene pendientes");
  } finally {
    await cerrar();
  }
});

test("intentos concurrentes de claim reparten los envíos sin repetir", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const campaniaId = await crearCampania(db, "enviando");
    await sembrarEnvios(db, campaniaId, 4);

    const reclamados = (await Promise.all(Array.from({ length: 4 }, () => reclamarEnvio(db)))).filter(Boolean);
    const ids = reclamados.map((e) => e!.id);
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, 4, "cada envío fue reclamado por un solo 'worker'");
  } finally {
    await cerrar();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Reparto por tenant en el claim (ROADMAP F8, PLAN-ESCALA-MULTITENANT): antes
// `reclamarEnvio` tomaba el envío pendiente más viejo SIN mirar el tenant, así
// que una campaña grande monopolizaba el worker mientras las de los demás
// esperaban. Ahora se prioriza el tenant que hace más tiempo no recibe turno.
// ─────────────────────────────────────────────────────────────────────────────

test("reclamarEnvio: un tenant con 1 envío no espera a que otro con 100 termine de drenar (F8)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const TENANT_GRANDE = "tenant-grande";
    const TENANT_CHICO = "tenant-chico";

    const campaniaGrande = await crearCampania(db, "enviando", TENANT_GRANDE);
    await sembrarEnvios(db, campaniaGrande, 100, TENANT_GRANDE);

    const campaniaChica = await crearCampania(db, "enviando", TENANT_CHICO);
    await sembrarEnvios(db, campaniaChica, 1, TENANT_CHICO);

    // Simula al worker: reclama y marca "enviado" (así el próximo claim ve el
    // último envío real del tenant y le puede tocar el turno a otro).
    const ordenTenants: string[] = [];
    for (let i = 0; i < 10; i++) {
      const envio = await reclamarEnvio(db);
      if (!envio) break;
      ordenTenants.push(envio.tenantId);
      await marcarEnviado(db, envio.id);
    }

    const posicion = ordenTenants.indexOf(TENANT_CHICO);
    assert.notEqual(posicion, -1, "el tenant chico recibió turno dentro de las primeras 10 vueltas");
    assert.ok(
      posicion < 5,
      `el tenant chico entró en la vuelta ${posicion + 1} de 10 — se esperaba bien al principio, no cerca del final`,
    );
  } finally {
    await cerrar();
  }
});

test("reclamarEnvio: reparto por tenant alterna en vez de agotar siempre al mismo (F8)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const TENANT_A = "tenant-a";
    const TENANT_B = "tenant-b";

    const campaniaA = await crearCampania(db, "enviando", TENANT_A);
    await sembrarEnvios(db, campaniaA, 5, TENANT_A);
    const campaniaB = await crearCampania(db, "enviando", TENANT_B);
    await sembrarEnvios(db, campaniaB, 5, TENANT_B);

    const ordenTenants: string[] = [];
    for (let i = 0; i < 10; i++) {
      const envio = await reclamarEnvio(db);
      if (!envio) break;
      ordenTenants.push(envio.tenantId);
      await marcarEnviado(db, envio.id);
    }

    assert.equal(ordenTenants.length, 10, "se reclaman los 10 envíos entre ambos tenants");
    // Con reparto por tenant, ningún tenant debería aparecer 3+ veces seguidas:
    // apenas envía uno, el otro (que hace más tiempo no envía) pasa a tener prioridad.
    let rachaMax = 1;
    let rachaActual = 1;
    for (let i = 1; i < ordenTenants.length; i++) {
      rachaActual = ordenTenants[i] === ordenTenants[i - 1] ? rachaActual + 1 : 1;
      rachaMax = Math.max(rachaMax, rachaActual);
    }
    assert.ok(rachaMax <= 2, `racha más larga del mismo tenant seguido: ${rachaMax} (se esperaba <= 2)`);
  } finally {
    await cerrar();
  }
});

test("no se reclama si la campaña NO está 'enviando' (cancelada a mitad)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const campaniaId = await crearCampania(db, "cancelada");
    await sembrarEnvios(db, campaniaId, 3);

    assert.equal(await reclamarEnvio(db), null, "una campaña cancelada no deja reclamar sus envíos pendientes");

    // Al reactivarla, sus envíos vuelven a estar disponibles.
    await db.update(waCampanias).set({ estado: "enviando" }).where(eq(waCampanias.id, campaniaId));
    assert.notEqual(await reclamarEnvio(db), null, "reactivada, sí se reclama");
  } finally {
    await cerrar();
  }
});

test("elegirEsperaMs: reintenta ya mismo tras un envío (el throttle real es por tenant, no acá); usa el poll si no había nada", () => {
  const poll = 2000;
  assert.equal(elegirEsperaMs(true, poll), 0, "tras un envío no fuerza espera global: otro tenant puede estar listo");
  assert.equal(elegirEsperaMs(false, poll), poll, "sin envíos usa el poll normal");
});

// ─────────────────────────────────────────────────────────────────────────────
// Throttle POR TENANT (ROADMAP F8): el límite de Meta es por número de
// WhatsApp (= por tenant), así que el mapa tenantId → próximo envío permitido
// debe dejar avanzar a un tenant que no envió hace rato aunque otro tenant
// acabe de consumir su propio turno.
// ─────────────────────────────────────────────────────────────────────────────

test("esperaThrottleTenant/registrarEnvioTenant: dos tenants no se esperan entre sí", () => {
  const mapa = new Map<string, number>();
  const intervalo = 1200;
  const ahora = 1_000_000;

  // Tenant A envía: queda "ocupado" hasta ahora + intervalo.
  assert.equal(esperaThrottleTenant(mapa, "tenant-a", ahora), 0, "A nunca envió: no espera nada");
  registrarEnvioTenant(mapa, "tenant-a", ahora, intervalo);

  // Tenant B, en el MISMO instante, no tiene por qué esperar el turno de A.
  assert.equal(esperaThrottleTenant(mapa, "tenant-b", ahora), 0, "B no depende del throttle de A");
  registrarEnvioTenant(mapa, "tenant-b", ahora, intervalo);

  // A, en cambio, si intenta de nuevo enseguida, sí debe esperar lo que falta.
  const esperaA = esperaThrottleTenant(mapa, "tenant-a", ahora + 100);
  assert.equal(esperaA, intervalo - 100, "A debe esperar lo que resta de SU propio intervalo");

  // Pasado el intervalo completo, A vuelve a estar libre.
  assert.equal(esperaThrottleTenant(mapa, "tenant-a", ahora + intervalo), 0, "tras el intervalo, A ya puede enviar de nuevo");
});

// ─────────────────────────────────────────────────────────────────────────────
// Purga por retención (ROADMAP F11): purgarEnviosFinalizados solo borra envíos
// de campañas PADRE ya 'completada'/'cancelada' y viejas.
// ─────────────────────────────────────────────────────────────────────────────

const diasAtras = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);

test("purgarEnviosFinalizados: borra envíos de una campaña 'completada' vieja, respeta el corte de días", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const vieja = await crearCampania(db, "completada");
    await db.update(waCampanias).set({ completadaEn: diasAtras(10) }).where(eq(waCampanias.id, vieja));
    await sembrarEnvios(db, vieja, 3);

    const reciente = await crearCampania(db, "completada");
    await db.update(waCampanias).set({ completadaEn: diasAtras(1) }).where(eq(waCampanias.id, reciente));
    await sembrarEnvios(db, reciente, 2);

    const borrados = await purgarEnviosFinalizados(db, 7);
    assert.equal(borrados, 3, "solo los envíos de la campaña completada hace 10 días cruzan el corte de 7");

    assert.equal(await quedanPendientes(db, vieja), false, "sin filas propias, no hay 'pendiente' para la vieja");
    const restantesReciente = await db.select().from(waCampaniaEnvios).where(eq(waCampaniaEnvios.campaniaId, reciente));
    assert.equal(restantesReciente.length, 2, "los envíos de la campaña reciente no se tocan");
  } finally {
    await cerrar();
  }
});

test("purgarEnviosFinalizados: NO toca envíos de una campaña 'enviando' (en curso) sin importar la antigüedad", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const campaniaId = await crearCampania(db, "enviando");
    await db.update(waCampanias).set({ iniciadaEn: diasAtras(30) }).where(eq(waCampanias.id, campaniaId));
    await sembrarEnvios(db, campaniaId, 4);

    const borrados = await purgarEnviosFinalizados(db, 7);
    assert.equal(borrados, 0, "'enviando' no es un estado final: la purga no la toca aunque sea vieja");

    const restantes = await db.select().from(waCampaniaEnvios).where(eq(waCampaniaEnvios.campaniaId, campaniaId));
    assert.equal(restantes.length, 4);
  } finally {
    await cerrar();
  }
});

test("purgarEnviosFinalizados: campaña 'cancelada' usa creada_en como corte (no tiene completada_en)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const campaniaId = await crearCampania(db, "cancelada");
    await db.update(waCampanias).set({ creadaEn: diasAtras(10) }).where(eq(waCampanias.id, campaniaId));
    await sembrarEnvios(db, campaniaId, 2);

    const borrados = await purgarEnviosFinalizados(db, 7);
    assert.equal(borrados, 2, "cancelada hace 10 días (por creada_en, sin completada_en) cruza el corte de 7");
  } finally {
    await cerrar();
  }
});

test("purgarEnviosFinalizados: borra por lotes y termina (no loop infinito)", async () => {
  const { db, cerrar } = await crearDbEfimera();
  try {
    const campaniaId = await crearCampania(db, "completada");
    await db.update(waCampanias).set({ completadaEn: diasAtras(10) }).where(eq(waCampanias.id, campaniaId));
    await sembrarEnvios(db, campaniaId, 5);

    const borrados = await purgarEnviosFinalizados(db, 7, 2); // lote de 2, con 5 filas → 3 vueltas
    assert.equal(borrados, 5);

    const restantes = await db.select().from(waCampaniaEnvios).where(eq(waCampaniaEnvios.campaniaId, campaniaId));
    assert.equal(restantes.length, 0);
  } finally {
    await cerrar();
  }
});
