import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import { applyIndustryTemplate } from "../src/modules/business";
import { businesses, locationHours, locations } from "../src/modules/business/schema";
import { applyCatalogTemplate } from "../src/modules/catalog";
import { serviceLocations, services, staffServices } from "../src/modules/catalog/schema";
import { clients } from "../src/modules/clients/schema";
import { recalculateAppointmentCommissions } from "../src/modules/commissions";
import { commissionRules } from "../src/modules/commissions/schema";
import { seedDefaultPaymentMethods } from "../src/modules/sales";
import { payments } from "../src/modules/sales/schema";
import { appointments, appointmentServices, type AppointmentChannel, type AppointmentStatus } from "../src/modules/scheduling/schema";
import { membershipLocations, memberships, staff, staffHours, users } from "../src/modules/team/schema";
import { hashPassword } from "../src/platform/auth/password";
import { withSystem, withTenant, type Executor } from "../src/platform/db/scope";

// ─────────────────────────────────────────────────────────────────────────────
// Seed de DESARROLLO: un negocio demo de estética para ver el producto con datos. Nace
// de la plantilla de rubro `aesthetics` (src/modules/business/templates/aesthetics.json:
// terminología, campos personalizados y catálogo de ejemplo), igual que un alta real; el
// seed le suma precios de demo, sucursales, equipo, clientes y citas.
//   Uso:  npm run seed:dev
//
// Base: DATABASE_URL_MIGRATIONS o DATABASE_URL si están (nunca con NODE_ENV=production);
// si no, PGlite en PGLITE_DIR (la misma carpeta que usa `npm run dev` sin DATABASE_URL:
// corré el seed con el server apagado, PGlite es de un solo proceso). Sin PGLITE_DIR, la
// base es en memoria y el seed solo sirve como prueba de humo.
//
// Idempotente: si el negocio demo ya existe, se borra (cascada) y se vuelve a crear.
// Crea tres usuarios con una clave CONOCIDA de desarrollo (se imprime por consola) para
// entrar al panel con POST /api/panel/auth/login: la dueña (todas las sucursales), una
// recepcionista que solo entra a Escazú (para ver el permiso por sucursal) y Ana, una
// especialista vinculada a su carril de la agenda ("Mi agenda": solo sus citas). Esa clave es
// pública (está en el repo): el seed se niega a correr con NODE_ENV=production.
// Teléfonos con prefijo +506 0… (no existen en Costa Rica) y correos @example.com /
// .test: nada de esto le llega a una persona real.
// ─────────────────────────────────────────────────────────────────────────────

export const DEMO_SLUG = "demo-estetica";
export const DEMO_OWNER_EMAIL = "owner@demo-estetica.test";
export const DEMO_FRONT_DESK_EMAIL = "recepcion@demo-estetica.test";
export const DEMO_STAFF_EMAIL = "ana@demo-estetica.test";
/** Clave de desarrollo de los usuarios demo. Solo desarrollo: es pública. */
export const DEMO_PASSWORD = "demo1234";

// Costa Rica no tiene horario de verano: el offset es fijo todo el año.
const TIMEZONE = "America/Costa_Rica";
const UTC_OFFSET = "-06:00";
const OFFSET_MS = -6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** ₡ → céntimos. */
const crc = (colones: number) => colones * 100;

export interface SeedResult {
  businessId: string;
  replaced: boolean;
  ownerEmail: string;
  frontDeskEmail: string;
  staffEmail: string;
  /** Clave de los usuarios demo (`DEMO_PASSWORD`). */
  password: string;
  counts: Record<"locations" | "staff" | "services" | "clients" | "appointments" | "payments", number>;
}

/** Siembra el negocio demo en `db`. `now` fija "esta semana" (default: ahora). */
export async function seedDev(db: Executor, options: { now?: Date } = {}): Promise<SeedResult> {
  const now = options.now ?? new Date();

  // Lo global (negocio previo y usuarios demo) es de sistema; el resto, con el alcance del negocio.
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const { replaced, ownerId, frontDeskId, staffUserId } = await withSystem(db, async (tx) => {
    const previous = await tx.delete(businesses).where(eq(businesses.slug, DEMO_SLUG)).returning({ id: businesses.id });
    await tx.delete(users).where(inArray(users.email, [DEMO_OWNER_EMAIL, DEMO_FRONT_DESK_EMAIL, DEMO_STAFF_EMAIL]));
    const [owner, frontDesk, staffUser] = await tx
      .insert(users)
      .values([
        { email: DEMO_OWNER_EMAIL, name: "Dueña Demo", passwordHash },
        { email: DEMO_FRONT_DESK_EMAIL, name: "Recepción Escazú", passwordHash },
        { email: DEMO_STAFF_EMAIL, name: "Ana Rojas", passwordHash },
      ])
      .returning({ id: users.id });
    return { replaced: previous.length > 0, ownerId: owner.id, frontDeskId: frontDesk.id, staffUserId: staffUser.id };
  });

  const businessId = randomUUID();
  const counts = await withTenant(db, businessId, async (tx) => {
    await tx.insert(businesses).values({
      id: businessId,
      slug: DEMO_SLUG,
      name: "Estética Demo",
      industry: "aesthetics",
      plan: "pro",
      // Pro por cantidad contratada: dos sucursales y lugar para sumar equipo en la demo.
      extraModules: { limits: { locations: 3, staff: 10, users: 10 } },
      currency: "CRC",
      country: "CR",
      timezone: TIMEZONE,
      reminderChannels: ["whatsapp", "email"],
    });
    // Plantilla de estética: terminología ("especialista"), campos y catálogo de ejemplo.
    await applyIndustryTemplate(tx, { businessId, industry: "aesthetics" }, { seedCatalog: applyCatalogTemplate });
    await tx.insert(memberships).values({ businessId, userId: ownerId, role: "owner" });

    // ── Sucursales y su horario (0 = domingo … 6 = sábado) ──
    const [escazu, heredia] = await tx
      .insert(locations)
      .values([
        { businessId, name: "Escazú", address: "Plaza Demo, local 4", phone: "+50600000100", timezone: TIMEZONE, position: 0 },
        { businessId, name: "Heredia", address: "Centro Comercial Demo, 2.º piso", phone: "+50600000200", timezone: TIMEZONE, position: 1 },
      ])
      .returning({ id: locations.id });
    // Recepción: solo Escazú (sin filas en membership_locations sería "todas").
    const [frontDeskMembership] = await tx
      .insert(memberships)
      .values({ businessId, userId: frontDeskId, role: "front_desk" })
      .returning({ id: memberships.id });
    await tx.insert(membershipLocations).values({ businessId, membershipId: frontDeskMembership.id, locationId: escazu.id });
    const block = (locationId: string, weekday: number, opensAt: string, closesAt: string) => ({
      businessId,
      locationId,
      weekday,
      opensAt,
      closesAt,
    });
    await tx.insert(locationHours).values([
      // Escazú: lunes a viernes con almuerzo, sábado medio día.
      ...[1, 2, 3, 4, 5].flatMap((d) => [block(escazu.id, d, "09:00", "13:00"), block(escazu.id, d, "14:00", "19:00")]),
      block(escazu.id, 6, "09:00", "15:00"),
      // Heredia: martes a sábado corrido.
      ...[2, 3, 4, 5, 6].map((d) => block(heredia.id, d, "10:00", "18:00")),
    ]);

    // ── Equipo y su horario por sucursal ──
    // Ana entra con su usuario (rol staff, todas las sucursales donde trabaja).
    const [anaMembership] = await tx
      .insert(memberships)
      .values({ businessId, userId: staffUserId, role: "staff" })
      .returning({ id: memberships.id });
    const [ana, carla, diego] = await tx
      .insert(staff)
      .values([
        { businessId, name: "Ana Rojas", color: "#e86a92", position: 0, membershipId: anaMembership.id },
        { businessId, name: "Carla Méndez", color: "#6a8ee8", position: 1 },
        { businessId, name: "Diego Vargas", color: "#5cb88a", position: 2 },
      ])
      .returning({ id: staff.id });
    const shift = (staffId: string, locationId: string, weekday: number, startsAt: string, endsAt: string) => ({
      businessId,
      staffId,
      locationId,
      weekday,
      startsAt,
      endsAt,
    });
    await tx.insert(staffHours).values([
      // Ana: lunes, miércoles y viernes en Escazú; martes y jueves en Heredia.
      ...[1, 3, 5].flatMap((d) => [shift(ana.id, escazu.id, d, "09:00", "13:00"), shift(ana.id, escazu.id, d, "14:00", "19:00")]),
      ...[2, 4].map((d) => shift(ana.id, heredia.id, d, "10:00", "18:00")),
      // Carla: Escazú de lunes a sábado.
      ...[1, 2, 3, 4, 5].flatMap((d) => [shift(carla.id, escazu.id, d, "09:00", "13:00"), shift(carla.id, escazu.id, d, "14:00", "19:00")]),
      shift(carla.id, escazu.id, 6, "09:00", "15:00"),
      // Diego: Heredia de martes a sábado.
      ...[2, 3, 4, 5, 6].map((d) => shift(diego.id, heredia.id, d, "10:00", "18:00")),
    ]);

    // ── Catálogo: el de la plantilla, con precios de demo (la plantilla los trae en null) ──
    const demoPrices: Record<string, number> = {
      "Limpieza facial profunda": 25_000,
      "Hidratación facial": 18_000,
      "Peeling químico": 30_000,
      "Masaje relajante": 22_000,
      "Drenaje linfático": 24_000,
      "Depilación de cejas": 5_000,
      "Depilación de piernas completas": 15_000,
      Manicura: 8_000,
      "Pedicura spa": 12_000,
    };
    for (const [name, colones] of Object.entries(demoPrices)) {
      await tx
        .update(services)
        .set({ priceCents: crc(colones) })
        .where(and(eq(services.businessId, businessId), eq(services.name, name)));
    }
    const serviceRows = await tx.select().from(services).where(eq(services.businessId, businessId));
    const svc = Object.fromEntries(serviceRows.map((s) => [s.name, s]));
    const pick = (name: string) => {
      const s = svc[name];
      if (!s) throw new Error(`seed:dev: la plantilla de estética ya no trae "${name}"`);
      return s;
    };
    const limpieza = pick("Limpieza facial profunda");
    const hidratacion = pick("Hidratación facial");
    const masaje = pick("Masaje relajante");
    const drenaje = pick("Drenaje linfático");
    const manicura = pick("Manicura");
    const pedicura = pick("Pedicura spa");
    // Manicura y pedicura solo en Escazú (el resto, sin filas = en todas las sucursales).
    await tx.insert(serviceLocations).values([
      { businessId, serviceId: manicura.id, locationId: escazu.id },
      { businessId, serviceId: pedicura.id, locationId: escazu.id },
    ]);
    // Ana hace faciales y corporales (con precio propio en la limpieza); Diego solo
    // corporales; Carla sin filas = hace todos.
    await tx.insert(staffServices).values([
      { businessId, staffId: ana.id, serviceId: limpieza.id, priceCents: crc(28_000) },
      { businessId, staffId: ana.id, serviceId: hidratacion.id },
      { businessId, staffId: ana.id, serviceId: masaje.id },
      { businessId, staffId: ana.id, serviceId: drenaje.id },
      { businessId, staffId: diego.id, serviceId: masaje.id },
      { businessId, staffId: diego.id, serviceId: drenaje.id, durationMin: 45 },
    ]);

    // Métodos de pago default, igual que el alta real (src/provisioning.ts).
    const methodRows = await seedDefaultPaymentMethods(tx, { businessId });
    const method = Object.fromEntries(methodRows.map((m) => [m.name, m.id]));

    // ── Clientes ──
    const clientSeed = [
      { name: "María Fernández", email: "maria@example.com", consent: true },
      { name: "Laura Jiménez", email: "laura@example.com", consent: true },
      { name: "Sofía Castro", email: null, consent: false },
      { name: "Valeria Solís", email: "valeria@example.com", consent: false },
      { name: "Daniela Araya", email: null, consent: true },
      { name: "Gabriela Mora", email: "gabriela@example.com", consent: false },
      { name: "Andrea Quesada", email: null, consent: false },
      { name: "Paula Chaves", email: "paula@example.com", consent: true },
      { name: "Natalia Brenes", email: null, consent: false },
      { name: "Camila Ulate", email: null, consent: false },
    ];
    const clientRows = await tx
      .insert(clients)
      .values(
        clientSeed.map((c, i) => ({
          businessId,
          name: c.name,
          phone: `+5060000${String(i + 1).padStart(4, "0")}`,
          email: c.email,
          source: i % 3 === 0 ? "Instagram" : i % 3 === 1 ? "Referido" : null,
          preferredChannel: c.email ? ("email" as const) : ("whatsapp" as const),
          marketingConsentAt: c.consent ? now : null,
          preferredLocationId: i % 2 === 0 ? escazu.id : heredia.id,
        })),
      )
      .returning({ id: clients.id });
    // Una menor con su madre como responsable (caso de uso de dental, también aplica acá).
    const [minor] = await tx
      .insert(clients)
      .values({ businessId, name: "Isabella Fernández", guardianId: clientRows[0].id, notes: "Menor: viene con su mamá." })
      .returning({ id: clients.id });

    // ── Citas de esta semana (lunes a sábado, hora de Costa Rica) ──
    const wallNow = new Date(now.getTime() + OFFSET_MS); // reloj de pared de CR, leído en UTC
    const monday = Date.UTC(wallNow.getUTCFullYear(), wallNow.getUTCMonth(), wallNow.getUTCDate() - ((wallNow.getUTCDay() + 6) % 7));
    const at = (dayOffset: number, hm: string) =>
      new Date(`${new Date(monday + dayOffset * DAY_MS).toISOString().slice(0, 10)}T${hm}:00${UTC_OFFSET}`);

    type Booking = {
      day: number;
      time: string;
      staffId: string;
      locationId: string;
      clientId: string;
      lines: (typeof serviceRows)[number][];
      channel: AppointmentChannel;
      outcome?: "cancelled" | "no_show" | "pending";
      method?: string;
    };
    const bookings: Booking[] = [
      { day: 0, time: "09:00", staffId: ana.id, locationId: escazu.id, clientId: clientRows[0].id, lines: [limpieza], channel: "whatsapp_ai", method: "SINPE Móvil" },
      { day: 0, time: "10:00", staffId: carla.id, locationId: escazu.id, clientId: clientRows[1].id, lines: [manicura, pedicura], channel: "panel", method: "Tarjeta" },
      { day: 1, time: "10:00", staffId: diego.id, locationId: heredia.id, clientId: clientRows[2].id, lines: [masaje], channel: "phone", method: "Efectivo" },
      { day: 1, time: "11:30", staffId: ana.id, locationId: heredia.id, clientId: clientRows[3].id, lines: [hidratacion], channel: "whatsapp_ai", outcome: "no_show" },
      { day: 2, time: "14:00", staffId: carla.id, locationId: escazu.id, clientId: clientRows[4].id, lines: [hidratacion], channel: "walk_in", method: "Efectivo" },
      { day: 2, time: "15:00", staffId: ana.id, locationId: escazu.id, clientId: clientRows[5].id, lines: [drenaje], channel: "whatsapp_ai", outcome: "cancelled" },
      { day: 3, time: "10:00", staffId: ana.id, locationId: heredia.id, clientId: clientRows[6].id, lines: [limpieza], channel: "panel", method: "SINPE Móvil" },
      { day: 3, time: "15:00", staffId: diego.id, locationId: heredia.id, clientId: clientRows[7].id, lines: [drenaje], channel: "whatsapp_ai", method: "Transferencia" },
      { day: 4, time: "09:00", staffId: carla.id, locationId: escazu.id, clientId: minor.id, lines: [manicura], channel: "panel", method: "Efectivo" },
      { day: 4, time: "16:00", staffId: ana.id, locationId: escazu.id, clientId: clientRows[8].id, lines: [masaje], channel: "whatsapp_ai", outcome: "pending" },
      { day: 5, time: "10:00", staffId: carla.id, locationId: escazu.id, clientId: clientRows[9].id, lines: [pedicura], channel: "whatsapp_ai", method: "SINPE Móvil" },
      { day: 5, time: "11:00", staffId: diego.id, locationId: heredia.id, clientId: clientRows[0].id, lines: [masaje], channel: "phone", outcome: "pending" },
    ];

    // Comisiones de demo (Pro): 10 % general y 15 % para Ana en la limpieza facial.
    await tx.insert(commissionRules).values([
      { businessId, kind: "percent", value: 1000 },
      { businessId, staffId: ana.id, serviceId: limpieza.id, kind: "percent", value: 1500 },
    ]);

    let appointmentCount = 0;
    let paymentCount = 0;
    for (const p of bookings) {
      const startsAt = at(p.day, p.time);
      // Simplificación del seed: ocupa la suma de duraciones + buffers (la regla real es de I1).
      const minutes = p.lines.reduce((n, s) => n + s.durationMin + s.bufferMin, 0);
      const endsAt = new Date(startsAt.getTime() + minutes * 60_000);
      const totalCents = p.lines.reduce((n, s) => n + s.priceCents, 0);
      const past = endsAt <= now;
      const status: AppointmentStatus =
        p.outcome === "cancelled" ? "cancelled" : p.outcome === "no_show" ? (past ? "no_show" : "confirmed") : past ? "completed" : p.outcome ?? "confirmed";
      const [appt] = await tx
        .insert(appointments)
        .values({
          businessId,
          locationId: p.locationId,
          clientId: p.clientId,
          staffId: p.staffId,
          startsAt,
          endsAt,
          status,
          channel: p.channel,
          totalCents,
          createdBy: p.channel === "whatsapp_ai" ? null : ownerId,
          confirmedAt: status === "pending" ? null : new Date(startsAt.getTime() - DAY_MS),
          cancelledAt: status === "cancelled" ? new Date(startsAt.getTime() - 2 * 60 * 60 * 1000) : null,
          cancellationReason: status === "cancelled" ? "La clienta reprogramará la próxima semana." : null,
        })
        .returning({ id: appointments.id });
      await tx.insert(appointmentServices).values(
        p.lines.map((s, position) => ({
          businessId,
          appointmentId: appt.id,
          serviceId: s.id,
          name: s.name,
          durationMin: s.durationMin,
          priceCents: s.priceCents,
          position,
        })),
      );
      appointmentCount++;

      if (status === "completed" && p.method) {
        await tx.insert(payments).values({
          businessId,
          locationId: p.locationId,
          clientId: p.clientId,
          appointmentId: appt.id,
          amountCents: totalCents,
          paymentMethodId: method[p.method],
          recordedBy: ownerId,
          paidAt: endsAt,
        });
        paymentCount++;
        // Caché del cliente (en la app la mantiene el servicio que completa la cita).
        const [c] = await tx.select().from(clients).where(eq(clients.id, p.clientId));
        await tx
          .update(clients)
          .set({
            visitCount: c.visitCount + 1,
            firstVisitAt: c.firstVisitAt ?? startsAt,
            lastVisitAt: startsAt,
            totalSpentCents: c.totalSpentCents + totalCents,
          })
          .where(eq(clients.id, p.clientId));
        // Comisión sobre lo cobrado (en la app la calcula el gancho de completar / cobrar).
        await recalculateAppointmentCommissions(tx, businessId, appt.id, { now });
      }
    }

    return {
      locations: 2,
      staff: 3,
      services: serviceRows.length,
      clients: clientRows.length + 1,
      appointments: appointmentCount,
      payments: paymentCount,
    };
  });

  return {
    businessId,
    replaced,
    ownerEmail: DEMO_OWNER_EMAIL,
    frontDeskEmail: DEMO_FRONT_DESK_EMAIL,
    staffEmail: DEMO_STAFF_EMAIL,
    password: DEMO_PASSWORD,
    counts,
  };
}

async function closeDb(db: unknown): Promise<void> {
  const client = (db as { $client?: { end?: () => Promise<void>; close?: () => Promise<void> } }).$client;
  if (client?.end) await client.end();
  else if (client?.close) await client.close();
}

async function main(): Promise<void> {
  await import("dotenv/config");
  if (process.env.NODE_ENV === "production") {
    console.error("❌ seed:dev es solo para desarrollo (NODE_ENV=production).");
    process.exit(1);
  }
  const { createDb, startLocalDb } = await import("../src/platform/db/client");
  const url = process.env.DATABASE_URL_MIGRATIONS ?? process.env.DATABASE_URL;
  const db = url ? createDb(url) : await startLocalDb(process.env.PGLITE_DIR);
  const where = url ? "la base de DATABASE_URL" : process.env.PGLITE_DIR ? `PGlite en ${process.env.PGLITE_DIR}` : "PGlite en memoria";
  try {
    const r = await seedDev(db);
    console.log(`✅ Negocio demo ${r.replaced ? "re" : ""}creado en ${where} (id ${r.businessId}).`);
    console.log(
      `   ${r.counts.locations} sucursales · ${r.counts.staff} profesionales · ${r.counts.services} servicios · ` +
        `${r.counts.clients} clientes · ${r.counts.appointments} citas de esta semana · ${r.counts.payments} pagos`,
    );
    console.log("   Usuarios de desarrollo (POST /api/panel/auth/login):");
    console.log(`     Dueña:                     ${r.ownerEmail} / ${r.password}`);
    console.log(`     Recepción (solo Escazú):   ${r.frontDeskEmail} / ${r.password}`);
    console.log(`     Especialista (Mi agenda):  ${r.staffEmail} / ${r.password}`);
    if (!url && !process.env.PGLITE_DIR) {
      console.log("   Ojo: sin PGLITE_DIR la base es en memoria y se pierde al terminar (sirve como prueba de humo).");
    }
  } finally {
    await closeDb(db);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("❌ seed:dev falló:", e instanceof Error ? e.message : e);
    if (e instanceof Error && e.cause instanceof Error) console.error("   causa:", e.cause.message);
    process.exit(1);
  });
}
