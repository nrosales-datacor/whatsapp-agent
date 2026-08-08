import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { crearDbEfimera } from "../helpers/pgliteDb";
import { waMensajes } from "../../src/db/schema";
import { RepositorioDrizzle } from "../../src/booking/drizzleRepository";
import {
  resolverMediaAPersistir,
  resolverMediaParaPanel,
  _resetearAvisoParaTests,
} from "../../src/storage/supabaseStorage";

// ─────────────────────────────────────────────────────────────────────────────
// ROADMAP F9 — "fotos fuera de Postgres" contra Postgres efímero (PGlite), mismo
// ángulo 5 de TESTING.md que webhooksCrudos.test.ts. Cubre las 4 aristas del
// ítem: subida guarda una ruta corta (no base64); el payload del panel firma una
// URL de corta vida para una ruta de Storage; una fila `data:` legada se
// devuelve tal cual (sin intentar firmarla); y sin las env vars de Storage
// configuradas, todo el flujo cae al comportamiento previo (persistir el data
// URL) sin romper nada.
//
// Supabase Storage se mockea a nivel de `globalThis.fetch` (no hay red real ni
// SDK): mismo criterio que `test/helpers/webhookMock.ts` para Graph/OpenAI, pero
// acotado a este archivo porque ningún otro test dispara llamadas a Storage
// (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY no están seteadas en el resto de la
// suite).
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = "https://proyecto-test.supabase.co";
const SUPABASE_KEY = "service-role-test-key";

/** Instala un fetch falso que atiende subida (`POST .../object/...`) y firma (`POST .../object/sign/...`). */
function instalarMockStorage() {
  const original = globalThis.fetch;
  const llamadas: { url: string; method: string }[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    llamadas.push({ url, method });

    if (url.includes("/storage/v1/object/sign/")) {
      return new Response(JSON.stringify({ signedURL: "/object/sign/wa-fotos/ruta-firmada?token=abc123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/storage/v1/object/")) {
      return new Response(JSON.stringify({ Key: "subido-ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`mock storage: URL no manejada: ${method} ${url}`);
  }) as typeof fetch;

  return {
    llamadas,
    restaurar: () => {
      globalThis.fetch = original;
    },
  };
}

function conCredencialesStorage<T>(fn: () => Promise<T>): Promise<T> {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SUPABASE_KEY;
  return fn().finally(() => {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  });
}

function sinCredencialesStorage<T>(fn: () => Promise<T>): Promise<T> {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  return fn().finally(() => {
    if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
    if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  });
}

const TENANT = "tenant-f9";
const CLIENTE = "50688880001";

test("subida exitosa: actualizarMediaMensaje guarda la RUTA corta en la columna, no el base64", async () => {
  const { db, cerrar } = await crearDbEfimera();
  const mock = instalarMockStorage();
  try {
    await conCredencialesStorage(async () => {
      const repo = new RepositorioDrizzle(db);
      const conv = await repo.obtenerOConversacion(TENANT, CLIENTE);
      await repo.guardarMensaje(TENANT, conv.id, {
        rol: "user",
        contenido: "[foto]",
        creadoEn: new Date().toISOString(),
        waMessageId: "wamid.f9.subida",
      });

      const dataUrlFallback = "data:image/jpeg;base64,ZmFrZS1qcGVn"; // por si algo fallara
      const ruta = await resolverMediaAPersistir(
        TENANT,
        conv.id,
        "wamid.f9.subida",
        Buffer.from("bytes-de-una-foto-de-mentiras"),
        "image/jpeg",
        dataUrlFallback,
      );

      assert.ok(!ruta.startsWith("data:"), "la ruta devuelta no debe ser un data URL");
      assert.equal(ruta, `${TENANT}/${conv.id}/wamid.f9.subida.jpg`, "ruta determinística tenantId/conversacionId/waMessageId.ext");

      await repo.actualizarMediaMensaje(TENANT, conv.id, "wamid.f9.subida", ruta, "imagen");

      const [fila] = await db.select().from(waMensajes).where(eq(waMensajes.waMessageId, "wamid.f9.subida"));
      assert.equal(fila.mediaUrl, ruta);
      assert.ok(!fila.mediaUrl!.startsWith("data:"), "en la base debe quedar la ruta, no el base64 completo");
      assert.ok(fila.mediaUrl!.length < 200, "una ruta corta ocupa un puñado de bytes, no varios MB");
    });
  } finally {
    mock.restaurar();
    await cerrar();
  }
});

test("payload del panel: una ruta de Storage se resuelve a una URL FIRMADA de corta vida", async () => {
  const { db, cerrar } = await crearDbEfimera();
  const mock = instalarMockStorage();
  try {
    await conCredencialesStorage(async () => {
      const repo = new RepositorioDrizzle(db);
      const conv = await repo.obtenerOConversacion(TENANT, CLIENTE);
      await repo.guardarMensaje(TENANT, conv.id, {
        rol: "user",
        contenido: "[foto]",
        creadoEn: new Date().toISOString(),
        waMessageId: "wamid.f9.panel",
      });
      const ruta = `${TENANT}/${conv.id}/wamid.f9.panel.jpg`;
      await repo.actualizarMediaMensaje(TENANT, conv.id, "wamid.f9.panel", ruta, "imagen");

      const llamadasAntes = mock.llamadas.length;
      const convParaPanel = await repo.obtenerConversacionPorId(TENANT, conv.id);
      const msg = convParaPanel!.mensajes.find((m) => m.waMessageId === "wamid.f9.panel");

      assert.ok(msg?.mediaUrl, "el mensaje debe traer mediaUrl");
      assert.notEqual(msg!.mediaUrl, ruta, "no debe devolver la ruta cruda al panel");
      assert.ok(msg!.mediaUrl!.startsWith(SUPABASE_URL), "debe ser una URL absoluta de Storage");
      assert.ok(msg!.mediaUrl!.includes("/object/sign/"), "debe ser el endpoint de URL firmada");
      assert.ok(msg!.mediaUrl!.includes("token="), "la URL firmada trae un token de corta vida");

      const llamadaDeFirma = mock.llamadas.slice(llamadasAntes).find((l) => l.url.includes("/object/sign/"));
      assert.ok(llamadaDeFirma, "se debió llamar al endpoint de firma de Supabase Storage");
    });
  } finally {
    mock.restaurar();
    await cerrar();
  }
});

test("payload del panel: un media_url legado ('data:...') se devuelve TAL CUAL, sin intentar firmarlo", async () => {
  const { db, cerrar } = await crearDbEfimera();
  const mock = instalarMockStorage();
  try {
    await conCredencialesStorage(async () => {
      const repo = new RepositorioDrizzle(db);
      const conv = await repo.obtenerOConversacion(TENANT, CLIENTE);
      const dataUrlLegado = "data:image/jpeg;base64,ZmFrZS1sZWdhY3ktcGhvdG8=";
      await repo.guardarMensaje(TENANT, conv.id, {
        rol: "user",
        contenido: "[foto]",
        creadoEn: new Date().toISOString(),
        waMessageId: "wamid.f9.legado",
      });
      await repo.actualizarMediaMensaje(TENANT, conv.id, "wamid.f9.legado", dataUrlLegado, "imagen");

      const llamadasAntes = mock.llamadas.length;
      const convParaPanel = await repo.obtenerConversacionPorId(TENANT, conv.id);
      const msg = convParaPanel!.mensajes.find((m) => m.waMessageId === "wamid.f9.legado");

      assert.equal(msg?.mediaUrl, dataUrlLegado, "una fila legada se devuelve intacta");
      assert.equal(
        mock.llamadas.length,
        llamadasAntes,
        "no debió llamarse a Storage para un valor que ya empieza con 'data:'",
      );
    });
  } finally {
    mock.restaurar();
    await cerrar();
  }
});

test("sin SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY: el flujo cae al comportamiento actual (guarda el data URL) sin romper", async () => {
  const { db, cerrar } = await crearDbEfimera();
  const mock = instalarMockStorage();
  try {
    await sinCredencialesStorage(async () => {
      _resetearAvisoParaTests();
      const repo = new RepositorioDrizzle(db);
      const conv = await repo.obtenerOConversacion(TENANT, CLIENTE);
      await repo.guardarMensaje(TENANT, conv.id, {
        rol: "user",
        contenido: "[foto]",
        creadoEn: new Date().toISOString(),
        waMessageId: "wamid.f9.sinconfig",
      });

      const dataUrlFallback = "data:image/jpeg;base64,c2luLXN0b3JhZ2UtY29uZmlndXJhZG8=";
      const resultado = await resolverMediaAPersistir(
        TENANT,
        conv.id,
        "wamid.f9.sinconfig",
        Buffer.from("bytes que nunca deberían subirse"),
        "image/jpeg",
        dataUrlFallback,
      );

      assert.equal(resultado, dataUrlFallback, "sin credenciales, cae al data URL de siempre");
      assert.equal(mock.llamadas.length, 0, "no debió intentar ninguna llamada de red a Storage");

      await repo.actualizarMediaMensaje(TENANT, conv.id, "wamid.f9.sinconfig", resultado, "imagen");
      const [fila] = await db.select().from(waMensajes).where(eq(waMensajes.waMessageId, "wamid.f9.sinconfig"));
      assert.equal(fila.mediaUrl, dataUrlFallback, "la fila queda con el data URL completo, como antes de F9");

      // Y el panel, sin Storage configurado, sigue mostrando ese data URL legado sin romper.
      const convParaPanel = await repo.obtenerConversacionPorId(TENANT, conv.id);
      const msg = convParaPanel!.mensajes.find((m) => m.waMessageId === "wamid.f9.sinconfig");
      assert.equal(msg?.mediaUrl, dataUrlFallback);
    });
  } finally {
    mock.restaurar();
    await cerrar();
  }
});

test("resolverMediaParaPanel: sin credenciales, una RUTA de Storage (no data:) se degrada a undefined en vez de reventar", async () => {
  await sinCredencialesStorage(async () => {
    const resultado = await resolverMediaParaPanel("otro-tenant/otra-conv/wamid.jpg");
    assert.equal(resultado, undefined, "no se puede firmar sin credenciales: el chat sigue andando sin esa foto");
  });
});

test("resolverMediaParaPanel: null/undefined no genera llamadas ni rompe", async () => {
  const mock = instalarMockStorage();
  try {
    await conCredencialesStorage(async () => {
      assert.equal(await resolverMediaParaPanel(null), undefined);
      assert.equal(await resolverMediaParaPanel(undefined), undefined);
      assert.equal(mock.llamadas.length, 0);
    });
  } finally {
    mock.restaurar();
  }
});
