import assert from "node:assert/strict";
import { test } from "node:test";
import { historialParaModelo, recortarHistorial } from "../../src/agent/historial";
import type { MensajeConversacion } from "../../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// Historial que ve el agente (revisión pre-venta 2026-10): tope de mensajes, ventana
// de días y separadores con la fecha de los mensajes que no son de hoy (en la zona
// del tenant), para que un "mañana" de hace una semana no se lea como mañana de hoy.
// ─────────────────────────────────────────────────────────────────────────────

const TZ = "America/Costa_Rica"; // UTC-6, sin horario de verano
// Viernes 2 de octubre de 2026, 15:00 en Costa Rica (21:00 UTC).
const AHORA = new Date("2026-10-02T21:00:00Z");

function msg(rol: "user" | "assistant", contenido: string, creadoEn: string): MensajeConversacion {
  return { rol, contenido, creadoEn };
}

test("recortarHistorial: deja solo los últimos N mensajes, en orden", () => {
  const mensajes = Array.from({ length: 50 }, (_, i) =>
    msg("user", `m${i}`, new Date(AHORA.getTime() - (50 - i) * 60_000).toISOString()),
  );
  const r = recortarHistorial(mensajes, { maxMensajes: 20, maxDias: 0, ahora: AHORA });
  assert.equal(r.length, 20);
  assert.equal(r[0].contenido, "m30");
  assert.equal(r.at(-1)!.contenido, "m49");
});

test("recortarHistorial: la ventana de días saca lo viejo (0 = sin ventana)", () => {
  const mensajes = [
    msg("user", "hace 40 días", new Date(AHORA.getTime() - 40 * 86_400_000).toISOString()),
    msg("user", "hace 10 días", new Date(AHORA.getTime() - 10 * 86_400_000).toISOString()),
    msg("user", "hoy", AHORA.toISOString()),
  ];
  assert.deepEqual(
    recortarHistorial(mensajes, { maxMensajes: 20, maxDias: 30, ahora: AHORA }).map((m) => m.contenido),
    ["hace 10 días", "hoy"],
  );
  assert.equal(recortarHistorial(mensajes, { maxMensajes: 20, maxDias: 0, ahora: AHORA }).length, 3);
});

test("recortarHistorial: un creadoEn ilegible no hace perder el mensaje", () => {
  const r = recortarHistorial([msg("user", "raro", "no-es-fecha")], { maxMensajes: 20, maxDias: 30, ahora: AHORA });
  assert.equal(r.length, 1);
});

test("historialParaModelo: todo de hoy → mismos mensajes, sin separadores", () => {
  const h = [msg("user", "Hola", "2026-10-02T15:00:00Z"), msg("assistant", "¡Hola! ¿En qué te ayudo?", "2026-10-02T15:01:00Z")];
  const r = historialParaModelo(h, TZ, AHORA);
  assert.deepEqual(r, [
    { role: "user", content: "Hola" },
    { role: "assistant", content: "¡Hola! ¿En qué te ayudo?" },
  ]);
});

test("historialParaModelo: los días anteriores llevan separador con la fecha relativa; vuelve a 'hoy'", () => {
  const h = [
    msg("user", "quiero cita para mañana", "2026-09-25T16:00:00Z"), // viernes 25 de septiembre (hace 7 días)
    msg("assistant", "Listo, mañana a las 9", "2026-09-25T16:01:00Z"),
    msg("user", "gracias", "2026-10-01T18:00:00Z"), // ayer
    msg("user", "hola de nuevo", "2026-10-02T20:00:00Z"), // hoy
  ];
  const r = historialParaModelo(h, TZ, AHORA);
  assert.equal(r.length, 7);
  assert.equal(r[0].role, "system");
  assert.match(String(r[0].content), /25 de septiembre/);
  assert.match(String(r[0].content), /hace 7 días/);
  assert.match(String(r[0].content), /ESA fecha/);
  // El contenido de los mensajes queda intacto (sin prefijos adentro).
  assert.deepEqual(r[1], { role: "user", content: "quiero cita para mañana" });
  assert.deepEqual(r[2], { role: "assistant", content: "Listo, mañana a las 9" });
  assert.equal(r[3].role, "system");
  assert.match(String(r[3].content), /\(ayer\)/);
  assert.deepEqual(r[4], { role: "user", content: "gracias" });
  assert.deepEqual(r[5], { role: "system", content: "[Mensajes de hoy]" });
  assert.deepEqual(r[6], { role: "user", content: "hola de nuevo" });
});

test("historialParaModelo: el día se calcula en la zona del tenant, no en UTC", () => {
  // 2026-10-02T03:00Z es el 1 de octubre a las 21:00 en Costa Rica → "ayer", aunque en
  // UTC ya sea el mismo día que AHORA.
  const r = historialParaModelo([msg("user", "nos vemos mañana", "2026-10-02T03:00:00Z")], TZ, AHORA);
  assert.equal(r.length, 2);
  assert.equal(r[0].role, "system");
  assert.match(String(r[0].content), /\(ayer\)/);
});
