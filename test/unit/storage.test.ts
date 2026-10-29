import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  _resetSignedUrlCacheForTests,
  cachedSignedUrl,
  deletePrefix,
  objectPath,
  signObjectUrl,
  storageConfigured,
  uploadObject,
} from "../../src/platform/storage/supabaseStorage";

// ─────────────────────────────────────────────────────────────────────────────
// Supabase Storage por REST (src/platform/storage/supabaseStorage.ts). Storage se mockea
// a nivel de `globalThis.fetch` (sin red real ni SDK): subida, firma con caché, rutas
// acotadas al negocio y el comportamiento sin credenciales.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = "https://proyecto-test.supabase.co";
const SUPABASE_KEY = "service-role-test-key";

let calls: { url: string; method: string; headers: Record<string, string> }[] = [];
const originalFetch = globalThis.fetch;
const previousEnv = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };

beforeEach(() => {
  _resetSignedUrlCacheForTests();
  calls = [];
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SUPABASE_KEY;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.includes("/storage/v1/object/sign/")) {
      return new Response(JSON.stringify({ signedURL: "/object/sign/media/ruta?token=abc123" }), { status: 200 });
    }
    if (url.includes("/storage/v1/object/list/")) return new Response("[]", { status: 200 });
    if (url.includes("/storage/v1/object/")) return new Response(JSON.stringify({ Key: "ok" }), { status: 200 });
    throw new Error(`mock storage: URL no manejada: ${method} ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of [["SUPABASE_URL", previousEnv.url], ["SUPABASE_SERVICE_ROLE_KEY", previousEnv.key]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("objectPath: arranca por el negocio y sanea cada segmento (no se escapa del prefijo)", () => {
  assert.equal(objectPath("t-1", "chats", "wamid.ABC=="), "t-1/chats/wamid.ABC__");
  assert.equal(objectPath("t-1", "../otro-negocio", "x"), "t-1/.._otro-negocio/x");
  assert.equal(objectPath("t-1", "..", "x"), "t-1/_/x", "un segmento '..' no puede subir de carpeta");
});

test("uploadObject: POST al bucket con service role (Authorization + apikey) y upsert; devuelve la ruta", async () => {
  const path = objectPath("t-1", "fotos", "f1.jpg");
  assert.equal(await uploadObject(path, Buffer.from("binario"), "image/jpeg"), path);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${SUPABASE_URL}/storage/v1/object/media/${path}`);
  assert.equal(calls[0].headers.Authorization, `Bearer ${SUPABASE_KEY}`);
  assert.equal(calls[0].headers.apikey, SUPABASE_KEY);
  assert.equal(calls[0].headers["x-upsert"], "true");
});

test("cachedSignedUrl: el refresco de una pantalla reusa la URL (una sola firma por objeto)", async () => {
  const path = objectPath("t-1", "fotos", "f2.jpg");
  const first = await cachedSignedUrl(path);
  const second = await cachedSignedUrl(path);
  assert.equal(first, `${SUPABASE_URL}/storage/v1/object/sign/media/ruta?token=abc123`);
  assert.equal(second, first, "misma URL: el navegador no vuelve a descargar el archivo");
  assert.equal(calls.filter((c) => c.url.includes("/object/sign/")).length, 1);
  assert.equal(await cachedSignedUrl(null), undefined);
  assert.equal(await cachedSignedUrl(undefined), undefined);
});

test("deletePrefix: rechaza prefijos inseguros (vacío o con '..') antes de tocar Storage", async () => {
  await assert.rejects(deletePrefix(""), /inválida/);
  await assert.rejects(deletePrefix("t-1/../otro"), /inválida/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await deletePrefix("t-1"), { configured: true, deleted: 0 });
});

test("sin credenciales: no está configurado, subir lanza y firmar devuelve null (sin llamadas)", async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert.equal(storageConfigured(), false);
  await assert.rejects(uploadObject("t-1/x.jpg", Buffer.from("x"), "image/jpeg"), /no configurado/);
  assert.equal(await signObjectUrl("t-1/x.jpg"), null);
  assert.equal(await cachedSignedUrl("t-1/x.jpg"), undefined);
  assert.deepEqual(await deletePrefix("t-1"), { configured: false, deleted: 0 });
  assert.equal(calls.length, 0);
});
