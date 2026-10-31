import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TERMINOLOGY } from "../../web/src/lib/contract";
import * as clients from "../../web/src/modules/clients/format";
import * as reports from "../../web/src/modules/reports/format";
import * as sales from "../../web/src/modules/sales/format";
import * as scheduling from "../../web/src/modules/scheduling/format";
import * as whatsapp from "../../web/src/modules/whatsapp/format";

// ─────────────────────────────────────────────────────────────────────────────
// Formatos de las secciones del panel (web/src/modules/*/format.ts): teléfonos, montos
// compactos, variaciones, porcentajes, duraciones y fechas en la zona del negocio (no la
// del proceso). Casos borde: null, cero, negativos, redondeos y cambios de horario.
// Sin DOM ni red.
// ─────────────────────────────────────────────────────────────────────────────

const CR = "America/Costa_Rica"; // UTC−6 todo el año

/** Intl separa con espacios duros (U+00A0, U+202F): se comparan como espacios comunes. */
function plain(text: string): string;
function plain(text: string | null): string | null;
function plain(text: string | null): string | null {
  return text === null ? null : text.replace(/[\u00a0\u202f]/g, " ");
}
const DENTAL = { ...DEFAULT_TERMINOLOGY, client: "paciente", clients: "pacientes", staffMember: "doctora" };

// ── Clientes ────────────────────────────────────────────────────────────────

test("clientes: formatPhone agrupa CR (+50x) y NANP (+1); el resto, tal cual", () => {
  assert.equal(clients.formatPhone("+50688887777"), "+506 8888 7777");
  assert.equal(clients.formatPhone("+50722223333"), "+507 2222 3333");
  assert.equal(clients.formatPhone("+13055550100"), "+1 305 555 0100");
  assert.equal(clients.formatPhone("+447911123456"), "+447911123456");
  assert.equal(clients.formatPhone("8888 7777"), "8888 7777");
  assert.equal(clients.formatPhone(null), "");
  assert.equal(clients.formatPhone(undefined), "");
});

test("clientes: phoneMatches con el número completo o sin código de país, nunca un pedazo", () => {
  const e164 = "+50688887777";
  assert.equal(clients.phoneMatches("8888 7777", e164), true);
  assert.equal(clients.phoneMatches("8888-7777", e164), true);
  assert.equal(clients.phoneMatches("+506 8888 7777", e164), true);
  assert.equal(clients.phoneMatches("50688887777", e164), true);
  assert.equal(clients.phoneMatches("888 7777", e164), false, "7 dígitos de un número de 11: falta más de un código de país");
  assert.equal(clients.phoneMatches("7777", e164), false, "muy corto");
  assert.equal(clients.phoneMatches("8888 7778", e164), false);
  assert.equal(clients.phoneMatches("1 506 8888 7777", e164), false, "más largo que el número");
  assert.equal(clients.phoneMatches("", e164), false);
  assert.equal(clients.phoneMatches("305 555 0100", "+13055550100"), true);
});

test("clientes: fechas en la zona del negocio y fechas sin hora que no se corren de día", () => {
  // 03:00 UTC del 17 = 21:00 del 16 en Costa Rica.
  assert.equal(clients.formatDay("2026-10-17T03:00:00Z", CR), "16 oct 2026");
  assert.equal(clients.formatDay("2026-10-17T03:00:00Z", "UTC"), "17 oct 2026");
  assert.ok(clients.formatDay("2026-10-17T03:00:00Z", "Zona/Inventada").length > 0, "zona inválida: no rompe");
  assert.equal(clients.formatDay("no es fecha", CR), "");
  assert.equal(clients.formatDay(null, CR), "");
  assert.equal(clients.formatDateOnly("1990-05-17"), "17 may 1990");
  assert.equal(clients.formatDateOnly("1990-01-01"), "1 ene 1990");
  assert.equal(clients.formatDateOnly("17/05/1990"), "17/05/1990", "lo que no es AAAA-MM-DD vuelve tal cual");
  assert.equal(clients.formatDateOnly(undefined), "");
});

test("clientes: nombre de un cliente eliminado según el rubro, e iniciales del avatar", () => {
  assert.equal(clients.displayName({ name: "Ana", anonymized: true }, DENTAL), "Paciente eliminado");
  assert.equal(clients.displayName({ name: "Ana", anonymized: true }, DEFAULT_TERMINOLOGY), "Cliente eliminado");
  assert.equal(clients.displayName({ name: "Ana" }, DENTAL), "Ana");
  assert.equal(clients.clientInitials("María Fernández López"), "ML");
  assert.equal(clients.clientInitials("  ana  "), "A");
  assert.equal(clients.clientInitials("álvaro"), "Á");
  assert.equal(clients.clientInitials(""), "?");
});

// ── Reportes ────────────────────────────────────────────────────────────────

test("reportes: formatRate con proporciones, cero y sin base", () => {
  assert.equal(reports.formatRate(0.375), "37,5 %");
  assert.equal(reports.formatRate(0), "0 %");
  assert.equal(reports.formatRate(1), "100 %");
  assert.equal(reports.formatRate(0.12345), "12,3 %");
  assert.equal(reports.formatRate(null), "—");
  assert.equal(reports.formatRate(Number.NaN), "—");
  assert.equal(reports.formatRate(Number.POSITIVE_INFINITY), "—");
});

test("reportes: formatMinutes redondea al minuto antes de partir en horas (nunca '60 min')", () => {
  assert.equal(reports.formatMinutes(750), "12 h 30 min");
  assert.equal(reports.formatMinutes(45), "45 min");
  assert.equal(reports.formatMinutes(120), "2 h");
  assert.equal(reports.formatMinutes(0), "0 min");
  assert.equal(reports.formatMinutes(59.6), "1 h");
  assert.equal(reports.formatMinutes(119.7), "2 h");
  assert.equal(reports.formatMinutes(90.4), "1 h 30 min");
  assert.equal(reports.formatMinutes(90_000), `${reports.formatInt(1500)} h`);
});

test("reportes: compactCents por escala, con el signo antes del símbolo y sin '1 000 k'", () => {
  assert.equal(reports.compactCents(120_000_000, "CRC"), "₡1,2 M");
  assert.equal(reports.compactCents(35_000_000, "CRC"), "₡350 k");
  assert.equal(reports.compactCents(90_000, "CRC"), "₡900");
  assert.equal(reports.compactCents(0, "CRC"), "₡0");
  assert.equal(reports.compactCents(-35_000_000, "CRC"), "-₡350 k");
  assert.equal(reports.compactCents(-90_000, "CRC"), "-₡900");
  assert.equal(reports.compactCents(-120_000_000, "CRC"), "-₡1,2 M");
  assert.equal(reports.compactCents(-40, "CRC"), "₡0", "menos de medio colón negativo no es '-₡0'");
  // Bordes de escala: se decide con el valor ya redondeado.
  assert.equal(reports.compactCents(99_999_999, "CRC"), "₡1 M");
  assert.equal(reports.compactCents(99_994_000, "CRC"), "₡999,9 k");
  assert.equal(reports.compactCents(99_950, "CRC"), "₡1 k");
  assert.equal(reports.compactCents(99_940, "CRC"), "₡999");
  assert.equal(reports.compactCents(150_000, "USD"), "$1,5 k");
});

test("reportes: deltaText contra el período anterior (sin base, cero, subidas y bajadas)", () => {
  assert.equal(reports.deltaText(0, 0), null);
  assert.equal(reports.deltaText(5, 0), "Sin datos del período anterior");
  assert.equal(reports.deltaText(112, 100), "+12 % vs. período anterior");
  assert.equal(reports.deltaText(88, 100), "-12 % vs. período anterior");
  assert.equal(reports.deltaText(100, 100), "0 % vs. período anterior");
  assert.equal(reports.deltaText(0, 100), "-100 % vs. período anterior");
  // Base negativa (más devoluciones que cobros): la mejora sigue siendo positiva.
  assert.equal(reports.deltaText(-50, -100), "+50 % vs. período anterior");
});

test("reportes: rangeLabel con un día, un mes y un cambio de año", () => {
  assert.equal(reports.rangeLabel("2026-10-05", "2026-10-05"), "5 oct 2026");
  assert.equal(reports.rangeLabel("2026-10-01", "2026-10-30"), "1 oct – 30 oct 2026");
  assert.equal(reports.rangeLabel("2025-12-28", "2026-01-03"), "28 dic 2025 – 3 ene 2026");
});

// ── Ventas y comisiones ─────────────────────────────────────────────────────

test("ventas: parsePercent acepta coma o punto, hasta 2 decimales, entre 0 y 100", () => {
  const cases: [string, number | null][] = [
    ["15", 1500],
    ["12,5", 1250],
    ["12.5", 1250],
    [" 7 ", 700],
    ["0", 0],
    ["100", 10_000],
    ["0,01", 1],
    ["100.01", null],
    ["101", null],
    ["-5", null],
    ["12.345", null],
    ["1.000", null],
    ["", null],
    ["abc", null],
    ["15 %", null],
  ];
  for (const [input, expected] of cases) assert.equal(sales.parsePercent(input), expected, JSON.stringify(input));
  // Ida y vuelta con formatPercent.
  assert.equal(sales.parsePercent(sales.formatPercent(1250)), 1250);
  assert.equal(sales.formatPercent(1500), "15");
  assert.equal(sales.formatPercent(1234), "12,34");
});

test("ventas: rótulos de reglas de comisión y de pagos", () => {
  assert.equal(sales.ruleValueLabel({ kind: "percent", value: 1250 }, "CRC"), "12,5 %");
  assert.equal(plain(sales.ruleValueLabel({ kind: "fixed", value: 400_000 }, "CRC")), "₡4 000 por servicio");
  assert.equal(sales.registeredLabel("payment"), "Cobro registrado");
  assert.equal(sales.registeredLabel("deposit"), "Seña registrada");
  assert.equal(sales.registeredLabel("refund"), "Devolución registrada");
  assert.equal(sales.scopeLabel("staff_service", DENTAL), "Doctora + servicio");
  assert.equal(sales.scopeLabel("staff", DENTAL), "Doctora");
  assert.equal(sales.scopeLabel("general", DENTAL), "General del negocio");

  const names = {
    staff: new Map([["s1", "Dra. Rojas"]]),
    services: new Map([["sv1", "Limpieza"]]),
    categories: new Map([["c1", "Higiene"]]),
  };
  const rule = (r: Partial<Parameters<typeof sales.ruleTargetLabel>[0]>) =>
    sales.ruleTargetLabel({ scope: "general", staffId: null, serviceId: null, categoryId: null, ...r }, names);
  assert.equal(rule({ scope: "staff_service", staffId: "s1", serviceId: "sv1" }), "Dra. Rojas · Limpieza");
  assert.equal(rule({ scope: "service", serviceId: "borrado" }), "Servicio borrado");
  assert.equal(rule({ scope: "category", categoryId: "borrada" }), "Categoría borrada");
  assert.equal(rule({ scope: "staff", staffId: "otro" }), "—");
  assert.equal(rule({ scope: "general" }), "Todos los servicios");
});

test("ventas: monthStart y shiftDate cruzan meses, años y bisiestos", () => {
  assert.equal(sales.monthStart("2026-10-22"), "2026-10-01");
  assert.equal(sales.shiftDate("2026-12-31", 1), "2027-01-01");
  assert.equal(sales.shiftDate("2026-03-01", -1), "2026-02-28");
  assert.equal(sales.shiftDate("2028-02-28", 1), "2028-02-29");
  assert.equal(sales.shiftDate("2026-10-22", 0), "2026-10-22");
  assert.equal(sales.shiftDate("2026-10-22", -30), "2026-09-22");
});

// ── Agenda ──────────────────────────────────────────────────────────────────

test("agenda: horas y fechas en la zona de la sucursal", () => {
  assert.equal(plain(scheduling.formatTime("2026-10-26T15:00:00Z", CR)), "9:00 a. m.");
  assert.equal(scheduling.formatTime("2026-10-26T15:00:00Z", "Zona/Inventada"), "15:00", "zona inválida: hora UTC, sin romper");
  assert.equal(scheduling.formatLongDate("2026-10-26"), "lunes, 26 de octubre");
  assert.equal(scheduling.formatShortDate("2026-10-26"), "lun, 26 oct");
  // 03:30 UTC del 27 = 21:30 del 26 en Costa Rica: la fecha es la local, no la UTC.
  assert.equal(plain(scheduling.formatWhen("2026-10-27T03:30:00Z", CR)), "lun, 26 oct, 9:30 p. m.");
  assert.equal(scheduling.minuteOfDay("2026-10-26T15:30:00Z", CR), 9 * 60 + 30);
  assert.equal(scheduling.minuteOfDay("2026-10-27T05:59:00Z", CR), 23 * 60 + 59);
});

test("agenda: dayRange es [00:00, 00:00) local, también en un cambio de horario", () => {
  assert.deepEqual(scheduling.dayRange("2026-10-26", CR), { from: "2026-10-26T06:00:00.000Z", to: "2026-10-27T06:00:00.000Z" });
  assert.deepEqual(scheduling.dayRange("2026-10-26", CR, 7), { from: "2026-10-26T06:00:00.000Z", to: "2026-11-02T06:00:00.000Z" });
  // Fin del horario de verano en Nueva York: ese día dura 25 horas.
  assert.deepEqual(scheduling.dayRange("2026-11-01", "America/New_York"), { from: "2026-11-01T04:00:00.000Z", to: "2026-11-02T05:00:00.000Z" });
  // Fin de mes y de año.
  assert.deepEqual(scheduling.dayRange("2026-12-31", "UTC"), { from: "2026-12-31T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" });
});

test("agenda: duración legible y estados activos", () => {
  assert.equal(scheduling.formatMinutes(75), "1 h 15 min");
  assert.equal(scheduling.formatMinutes(60), "1 h");
  assert.equal(scheduling.formatMinutes(30), "30 min");
  assert.equal(scheduling.formatMinutes(0), "0 min");
  assert.equal(scheduling.isActive("pending"), true);
  assert.equal(scheduling.isActive("confirmed"), true);
  assert.equal(scheduling.isActive("cancelled"), false);
  assert.equal(scheduling.isActive("completed"), false);
  assert.equal(scheduling.isActive("no_show"), false);
  assert.match(scheduling.todayIn(CR), /^\d{4}-\d{2}-\d{2}$/);
});

// ── WhatsApp IA ─────────────────────────────────────────────────────────────

const conv = (name: string | null, phone: string | null) => ({ id: "c1", name, phone });

test("whatsapp: nombre y avatar de la conversación, con o sin ficha", () => {
  assert.equal(whatsapp.clientLabel(conv("  Ana Mora ", "+50688887777")), "Ana Mora");
  assert.equal(whatsapp.clientLabel(conv(null, "+50688887777")), "+506 8888 7777");
  assert.equal(whatsapp.clientLabel(conv("  ", null)), "Sin nombre");
  assert.equal(whatsapp.avatarText(conv("María José Fernández", null)), "MF");
  assert.equal(whatsapp.avatarText(conv(null, "+50688887734")), "34");
  assert.equal(whatsapp.avatarText(conv(null, null)), "?");
});

test("whatsapp: hora de la bandeja y separadores de día relativos a hoy en la zona del negocio", () => {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const today = scheduling.todayIn(CR);
  const HOUR = 3_600_000;

  assert.equal(whatsapp.formatListTime(iso(0), CR), scheduling.formatTime(iso(0), CR), "hoy: la hora");
  assert.equal(whatsapp.formatListTime(iso(24 * HOUR), CR), "Ayer");
  const threeDaysAgo = whatsapp.localDate(iso(72 * HOUR), CR);
  assert.match(plain(whatsapp.formatListTime(iso(72 * HOUR), CR)), /^[a-záé]{3}$/, `hace 3 días (${threeDaysAgo}): el día de la semana`);
  assert.match(plain(whatsapp.formatListTime(iso(30 * 24 * HOUR), CR)), /^\d{1,2} [a-z]{3,4}$/, "hace un mes: día y mes");

  assert.equal(whatsapp.formatDayLabel(today, CR), "Hoy");
  assert.equal(whatsapp.formatDayLabel(whatsapp.addDays(today, -1), CR), "Ayer");
  assert.equal(whatsapp.formatDayLabel("2020-10-19", CR), "lunes, 19 de octubre de 2020", "otro año: con año");
  assert.equal(whatsapp.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(whatsapp.localDate("2026-10-27T03:30:00Z", CR), "2026-10-26");
});

test("whatsapp: costo de IA y porcentajes", () => {
  assert.match(whatsapp.formatAiCost(12_400_000), /12,40/);
  assert.match(whatsapp.formatAiCost(0), /0,00/);
  assert.equal(whatsapp.formatPercent(1, 3), "33 %");
  assert.equal(whatsapp.formatPercent(0, 10), "0 %");
  assert.equal(whatsapp.formatPercent(5, 0), "—", "sin total no hay porcentaje");
});
