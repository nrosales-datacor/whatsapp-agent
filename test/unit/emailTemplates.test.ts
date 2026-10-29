import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appointmentConfirmationEmail,
  appointmentReminderEmail,
  DEFAULT_BRAND_COLOR,
  escapeHtml,
  formatAppointmentDateTime,
  formatDuration,
  invitationEmail,
  normalizeBrandColor,
  passwordResetEmail,
  type AppointmentReminderEmailData,
} from "../../src/platform/email/templates";

// ─────────────────────────────────────────────────────────────────────────────
// Plantillas de correo (src/platform/email/templates.ts): escape de TODA interpolación
// en el HTML, links solo http(s), color de marca saneado, y fecha/hora de la cita en la
// zona horaria de la sucursal con Intl es-CR.
// ─────────────────────────────────────────────────────────────────────────────

/** Intl separa "9:00 a. m." con espacios finos/no separables: se normalizan para comparar. */
const spaces = (s: string) => s.replace(/\s/g, " ");

const reminder: AppointmentReminderEmailData = {
  businessName: "Clínica Sonrisa",
  clientName: "María",
  services: ["Limpieza dental", "Blanqueamiento"],
  startsAt: new Date("2026-10-20T15:00:00Z"),
  timeZone: "America/Costa_Rica",
  locationName: "Sede Escazú",
  locationAddress: "Plaza Itskatzú, local 12",
  staffName: "Dra. Mora",
  confirmUrl: "https://app.selyon.app/c/abc?a=1&b=2",
  cancelUrl: "https://app.selyon.app/x/abc",
};

test("escapeHtml: escapa los 5 caracteres peligrosos", () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&</a>`), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeHtml(null), "");
});

test("plantillas: toda interpolación va escapada en el HTML (negocio, cliente, servicios, dirección…)", () => {
  const evil = {
    ...reminder,
    businessName: `<script>alert("negocio")</script>`,
    clientName: `<img src=x onerror=alert(1)>`,
    services: [`<b>Uñas</b>`],
    staffName: `"><svg onload=alert(2)>`,
    locationName: `Sede 'Centro'`,
    locationAddress: `Calle 1 & Av. 2 <br>`,
  };
  const outputs = [
    appointmentReminderEmail(evil),
    appointmentConfirmationEmail(evil),
    invitationEmail({ businessName: evil.businessName, inviteeName: evil.clientName, invitedByName: evil.staffName, acceptUrl: "https://app.selyon.app/i/t" }),
    passwordResetEmail({ businessName: evil.businessName, userName: evil.clientName, resetUrl: "https://app.selyon.app/r/t", expiresInMinutes: 60 }),
  ];
  for (const { html, text } of outputs) {
    assert.ok(!html.includes("<script>"), "sin <script> crudo");
    assert.ok(!html.includes("<img"), "sin <img> crudo");
    assert.ok(!html.includes("<svg"), "sin <svg> crudo");
    assert.ok(!html.includes("<b>Uñas"), "sin <b> crudo");
    assert.ok(!/onerror=|onload=/.test(html.replace(/&lt;[^&]*&gt;/g, "")), "sin atributos inyectados fuera de texto escapado");
    assert.ok(html.includes("&lt;script&gt;alert(&quot;negocio&quot;)&lt;/script&gt;"));
    // La versión texto es texto plano: lleva los valores tal cual (no hay HTML que romper).
    assert.ok(text.includes(`<script>alert("negocio")</script>`));
  }
  const html = appointmentReminderEmail(evil).html;
  assert.ok(html.includes("Calle 1 &amp; Av. 2 &lt;br&gt;"));
  assert.ok(html.includes("Sede &#39;Centro&#39;"));
});

test("links: solo http(s), y escapados dentro del href", () => {
  const { html, text } = appointmentReminderEmail(reminder);
  assert.ok(html.includes(`href="https://app.selyon.app/c/abc?a=1&amp;b=2"`));
  assert.ok(text.includes("Confirmar asistencia: https://app.selyon.app/c/abc?a=1&b=2"));
  assert.throws(() => appointmentReminderEmail({ ...reminder, confirmUrl: "javascript:alert(1)" }), /confirmUrl.*http/);
  assert.throws(() => invitationEmail({ businessName: "X", acceptUrl: "no es url" }), /acceptUrl/);
  assert.throws(() => passwordResetEmail({ resetUrl: "data:text/html,hola", expiresInMinutes: 30 }), /resetUrl/);
});

test("color de marca: hex válido se usa (y el texto se adapta al contraste); cualquier otra cosa cae al default", () => {
  assert.equal(normalizeBrandColor("#0B7"), "#00bb77");
  assert.equal(normalizeBrandColor("#AbCdEf"), "#abcdef");
  assert.equal(normalizeBrandColor("red;background:url(javascript:alert(1))"), DEFAULT_BRAND_COLOR);
  assert.equal(normalizeBrandColor(null), DEFAULT_BRAND_COLOR);

  const dark = invitationEmail({ businessName: "N", brandColor: "#1d4ed8", acceptUrl: "https://a.co/i" }).html;
  assert.ok(dark.includes("background:#1d4ed8;color:#ffffff"), "texto blanco sobre color oscuro");
  const light = invitationEmail({ businessName: "N", brandColor: "#fde68a", acceptUrl: "https://a.co/i" }).html;
  assert.ok(light.includes("background:#fde68a;color:#111827"), "texto oscuro sobre color claro");
  const injected = invitationEmail({ businessName: "N", brandColor: `#fff"><script>`, acceptUrl: "https://a.co/i" }).html;
  assert.ok(!injected.includes("<script>") && injected.includes(`background:${DEFAULT_BRAND_COLOR}`));
});

test("fecha y hora: en la zona horaria de la sucursal, con Intl es-CR", () => {
  const at = new Date("2026-10-20T15:00:00Z");
  const cr = formatAppointmentDateTime(at, "America/Costa_Rica");
  assert.equal(cr.date, "martes, 20 de octubre de 2026");
  assert.equal(spaces(cr.time), "9:00 a. m.");
  assert.equal(spaces(formatAppointmentDateTime(at, "Europe/Madrid").time), "5:00 p. m.");

  // Las 03:30 UTC del 21 son todavía el 20 en Costa Rica (UTC-6): el día también cambia.
  const late = new Date("2026-10-21T03:30:00Z");
  const lateCr = formatAppointmentDateTime(late, "America/Costa_Rica");
  assert.equal(lateCr.date, "martes, 20 de octubre de 2026");
  assert.equal(spaces(lateCr.time), "9:30 p. m.");
  const lateUtc = formatAppointmentDateTime(late, "UTC");
  assert.equal(lateUtc.date, "miércoles, 21 de octubre de 2026");
  assert.equal(spaces(lateUtc.time), "3:30 a. m.");

  assert.throws(() => formatAppointmentDateTime(at, "Marte/Base"), /zona horaria inválida/);
  assert.throws(() => formatAppointmentDateTime(new Date("x"), "UTC"), /fecha de la cita inválida/);
});

test("recordatorio: negocio, cliente, servicios, fecha/hora local, profesional, sucursal y links", () => {
  const { subject, html, text } = appointmentReminderEmail(reminder);
  assert.equal(subject, "Recordatorio de su cita en Clínica Sonrisa");
  const t = spaces(text);
  for (const expected of [
    "Hola, María",
    "Servicios: Limpieza dental, Blanqueamiento",
    "Fecha: martes, 20 de octubre de 2026",
    "Hora: 9:00 a. m.",
    "Profesional: Dra. Mora",
    "Sucursal: Sede Escazú",
    "Dirección: Plaza Itskatzú, local 12",
    "Cancelar cita: https://app.selyon.app/x/abc",
  ]) {
    assert.ok(t.includes(expected), `falta en el texto: ${expected}`);
  }
  assert.ok(html.includes("Confirmar asistencia") && html.includes("Cancelar cita"));
  assert.ok(spaces(html).includes("9:00 a. m."));
  assert.ok(html.includes("Clínica Sonrisa · Enviado con Selyon CRM"));

  // Sin links opcionales ni dirección/profesional: sin botones y con la alternativa de contactar al negocio.
  const bare = appointmentReminderEmail({ ...reminder, services: ["Corte"], confirmUrl: null, cancelUrl: undefined, staffName: null, locationAddress: "" });
  assert.ok(!bare.html.includes("<a href"));
  assert.ok(bare.text.includes("Servicio: Corte"));
  assert.ok(!bare.text.includes("Profesional:") && !bare.text.includes("Dirección:"));
  assert.ok(bare.text.includes("comuníquese con el negocio"));
});

test("cita agendada: detalles y link para cancelar opcional", () => {
  const { subject, text } = appointmentConfirmationEmail({ ...reminder, cancelUrl: "https://app.selyon.app/x/1" });
  assert.equal(subject, "Su cita en Clínica Sonrisa quedó agendada");
  assert.ok(text.includes("Cancelar cita: https://app.selyon.app/x/1"));
  assert.ok(spaces(text).includes("Hora: 9:00 a. m."));
});

test("invitación y recuperación de clave: link y vencimiento", () => {
  const invite = invitationEmail({
    businessName: "Uñas Bellas",
    inviteeName: "Sofía",
    invitedByName: "Laura",
    acceptUrl: "https://app.selyon.app/invite/tok",
    expiresInMinutes: 2880,
  });
  assert.equal(invite.subject, "Te invitaron a Uñas Bellas en Selyon CRM");
  assert.ok(invite.text.includes("Laura te invitó a unirte al equipo de Uñas Bellas"));
  assert.ok(invite.text.includes("Crear mi clave: https://app.selyon.app/invite/tok"));
  assert.ok(invite.text.includes("Este enlace vence en 2 días."));
  assert.ok(invite.html.includes(`href="https://app.selyon.app/invite/tok"`));

  const reset = passwordResetEmail({ resetUrl: "https://app.selyon.app/reset/tok", expiresInMinutes: 60 });
  assert.equal(reset.subject, "Restablecé tu clave de Selyon CRM");
  assert.ok(reset.text.includes("Este enlace vence en 1 hora."));
  assert.ok(reset.html.includes(">Selyon CRM</td>"), "sin negocio, el encabezado es el producto");
  assert.throws(() => passwordResetEmail({ resetUrl: "https://a.co/r", expiresInMinutes: 0 }), /vigencia/);
});

test("formatDuration: minutos, horas y días en español", () => {
  assert.equal(formatDuration(1), "1 minuto");
  assert.equal(formatDuration(30), "30 minutos");
  assert.equal(formatDuration(90), "90 minutos");
  assert.equal(formatDuration(60), "1 hora");
  assert.equal(formatDuration(180), "3 horas");
  assert.equal(formatDuration(1440), "1 día");
  assert.equal(formatDuration(10080), "7 días");
  assert.equal(formatDuration(1500), "25 horas");
});
