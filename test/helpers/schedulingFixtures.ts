import { randomUUID } from "node:crypto";
import { businesses, locationHours, locations } from "../../src/modules/business/schema";
import { services, staffServices } from "../../src/modules/catalog/schema";
import { clients } from "../../src/modules/clients/schema";
import { staff, staffHours } from "../../src/modules/team/schema";
import { addDays, localDate, zonedInstant } from "../../src/modules/scheduling/time";
import { withTenant, type Db } from "../../src/platform/db/scope";

// ─────────────────────────────────────────────────────────────────────────────
// Negocio de prueba para la Agenda (test/reliability/{appointments,reminders}.test.ts y
// test/security/scheduling.test.ts). Todos los días, en Costa Rica:
//
//   Escazú  08:00–12:00 y 13:00–19:00 (almuerzo de 12 a 13)
//   Heredia 08:00–18:00
//   Ana     Escazú, el horario completo; hace todos los servicios
//   Beto    Escazú, 13:00–19:00; solo Limpieza, con precio y duración propios (45 min)
//   Carla   Heredia, 08:00–18:00
//   Servicios: Limpieza 60 + 10 de buffer · Manicura 40 + 5 · Pedicura 60 + 10 ·
//              Masaje 60 (solo panel: no se agenda en línea)
//   Clientes:  María (con correo) y Sofía (sin correo)
// ─────────────────────────────────────────────────────────────────────────────

export const CR = "America/Costa_Rica";

export interface SchedulingWorld {
  businessId: string;
  escazu: string;
  heredia: string;
  ana: string;
  beto: string;
  carla: string;
  limpieza: string;
  manicura: string;
  pedicura: string;
  masaje: string;
  maria: string;
  sofia: string;
}

export async function createSchedulingWorld(db: Db, options: { reminderChannels?: ("whatsapp" | "email")[] } = {}): Promise<SchedulingWorld> {
  const businessId = randomUUID();
  return withTenant(db, businessId, async (tx) => {
    await tx.insert(businesses).values({
      id: businessId,
      slug: `agenda-${businessId.slice(0, 8)}`,
      name: "Estética Agenda",
      timezone: CR,
      reminderChannels: options.reminderChannels ?? ["whatsapp", "email"],
    });
    const [escazu, heredia] = await tx
      .insert(locations)
      .values([
        { businessId, name: "Escazú", address: "Plaza Demo", timezone: CR, position: 0 },
        { businessId, name: "Heredia", timezone: CR, position: 1 },
      ])
      .returning({ id: locations.id });
    const days = [0, 1, 2, 3, 4, 5, 6];
    await tx.insert(locationHours).values([
      ...days.flatMap((weekday) => [
        { businessId, locationId: escazu.id, weekday, opensAt: "08:00", closesAt: "12:00" },
        { businessId, locationId: escazu.id, weekday, opensAt: "13:00", closesAt: "19:00" },
      ]),
      ...days.map((weekday) => ({ businessId, locationId: heredia.id, weekday, opensAt: "08:00", closesAt: "18:00" })),
    ]);
    const [ana, beto, carla] = await tx
      .insert(staff)
      .values([
        { businessId, name: "Ana", color: "#e86a92", position: 0 },
        { businessId, name: "Beto", color: "#6a8ee8", position: 1 },
        { businessId, name: "Carla", color: "#5cb88a", position: 2 },
      ])
      .returning({ id: staff.id });
    await tx.insert(staffHours).values([
      ...days.flatMap((weekday) => [
        { businessId, staffId: ana.id, locationId: escazu.id, weekday, startsAt: "08:00", endsAt: "12:00" },
        { businessId, staffId: ana.id, locationId: escazu.id, weekday, startsAt: "13:00", endsAt: "19:00" },
        { businessId, staffId: beto.id, locationId: escazu.id, weekday, startsAt: "13:00", endsAt: "19:00" },
        { businessId, staffId: carla.id, locationId: heredia.id, weekday, startsAt: "08:00", endsAt: "18:00" },
      ]),
    ]);
    const [limpieza, manicura, pedicura, masaje] = await tx
      .insert(services)
      .values([
        { businessId, name: "Limpieza", durationMin: 60, bufferMin: 10, priceCents: 2_500_000, position: 0 },
        { businessId, name: "Manicura", durationMin: 40, bufferMin: 5, priceCents: 800_000, position: 1 },
        { businessId, name: "Pedicura", durationMin: 60, bufferMin: 10, priceCents: 1_200_000, position: 2 },
        { businessId, name: "Masaje", durationMin: 60, bufferMin: 0, priceCents: 2_200_000, position: 3, onlineBooking: false },
      ])
      .returning({ id: services.id });
    await tx.insert(staffServices).values({ businessId, staffId: beto.id, serviceId: limpieza.id, priceCents: 3_000_000, durationMin: 45 });
    const [maria, sofia] = await tx
      .insert(clients)
      .values([
        { businessId, name: "María Fernández", phone: "+50688880001", email: "maria@example.com" },
        { businessId, name: "Sofía Castro", phone: "+50688880002" },
      ])
      .returning({ id: clients.id });
    return {
      businessId,
      escazu: escazu.id,
      heredia: heredia.id,
      ana: ana.id,
      beto: beto.id,
      carla: carla.id,
      limpieza: limpieza.id,
      manicura: manicura.id,
      pedicura: pedicura.id,
      masaje: masaje.id,
      maria: maria.id,
      sofia: sofia.id,
    };
  });
}

/** Día local de Costa Rica dentro de `days` días ("AAAA-MM-DD"). */
export function crDay(days: number, from = new Date()): string {
  return addDays(localDate(from, CR), days);
}

/** Instante de la hora local "HH:MM" de ese día en Costa Rica. */
export function crAt(date: string, hm: string): Date {
  const [h, m] = hm.split(":").map(Number);
  return zonedInstant(date, h * 60 + m, CR);
}
