import { and, eq } from "drizzle-orm";
import { createBusiness, DEFAULT_LOCATION_HOURS, listLocations, type Industry } from "../src/modules/business";
import { getServices } from "../src/modules/catalog";
import { services } from "../src/modules/catalog/schema";
import { findOrCreateClientByPhone } from "../src/modules/clients";
import { bookAppointment } from "../src/modules/scheduling";
import { staff, staffHours } from "../src/modules/team/schema";
import { updateAiSettings } from "../src/modules/whatsapp/settings";
import type { AgentGrowth, AgentHistoryMessage, AgentTurnInput } from "../src/modules/whatsapp/agentContract";
import { addDays, localDate, zonedInstant } from "../src/modules/whatsapp/agent/time";
import { withTenant, type Executor } from "../src/platform/db/scope";
import { PROVISIONING_STEPS } from "../src/provisioning";
import { seedDev } from "../scripts/seedDev";
import { caseTemplate, type EvalCase } from "./assertions";

// ─────────────────────────────────────────────────────────────────────────────
// El "mundo" de cada caso de eval: el negocio sobre el que corre el agente, el cliente que
// escribe y lo que el caso pide sembrar (citas, registro, crecimiento). Aparte de
// runEval.ts para que el test del arnés (test/unit/evalHarness.test.ts) lo pueda sembrar
// sin OpenAI.
//
//   • Estética (default): el negocio demo de `seed:dev` (dos sucursales, Escazú y Heredia,
//     con precios, equipo y citas de la semana). Es lo que corrían los 13 casos originales.
//   • Otra plantilla (`template`: dental, nails, generic): un negocio NUEVO de ese rubro,
//     creado con `createBusiness` (el alta real: terminología, campos, catálogo y registro
//     de la plantilla), con una sola sucursal "Escazú" en el horario por defecto del alta
//     (lunes a viernes 08–18, sábado 08–12), dos personas del equipo con ese mismo horario y
//     los precios de demo de `TEMPLATE_PRICES` (la plantilla trae los precios en null).
//
// Todo va a la base efímera de la corrida: cada caso siembra su propio negocio.
// ─────────────────────────────────────────────────────────────────────────────

export const EVAL_TZ = "America/Costa_Rica";
export const CLIENT_PHONE = "+50688887777";
export const CLIENT_NAME = "Marco Jiménez";
/** Sucursal del canal en todos los mundos (en estética, además, existe Heredia). */
export const CHANNEL_LOCATION = "Escazú";

/** Nombre del negocio de eval de cada plantilla (estética usa el de `seed:dev`). */
const TEMPLATE_BUSINESS_NAMES: Record<Exclude<Industry, "aesthetics">, string> = {
  dental: "Clínica Dental Demo",
  nails: "Uñas Demo",
  generic: "Servicios Demo",
};

/**
 * Precios de demo (₡) de los servicios de cada plantilla. `null` = sin precio de lista: el
 * agente lo ve como "se cotiza" (si el servicio tiene precio variable en la plantilla, un
 * número acá se muestra como "desde ₡X (se cotiza)").
 */
export const TEMPLATE_PRICES: Record<Exclude<Industry, "aesthetics">, Record<string, number | null>> = {
  dental: {
    "Valoración inicial": 15_000,
    "Limpieza dental": 30_000,
    "Aplicación de flúor": 10_000,
    "Radiografía periapical": 8_000,
    "Resina (calza)": null,
    Endodoncia: null,
    Blanqueamiento: 120_000,
    "Control de ortodoncia": 20_000,
    "Extracción simple": null,
  },
  nails: {
    "Manicura tradicional": 7_000,
    "Manicura semipermanente": 12_000,
    "Uñas acrílicas (set completo)": 20_000,
    "Relleno de acrílico": 15_000,
    "Pedicura tradicional": 9_000,
    "Pedicura spa": 14_000,
    "Retiro de semipermanente": 4_000,
    "Decoración por uña": 1_000,
  },
  generic: {
    Consulta: 20_000,
    "Sesión": 35_000,
    Seguimiento: 15_000,
  },
};

const crc = (colones: number) => colones * 100;

export interface CaseWorld {
  businessId: string;
  clientId: string;
  /** Sucursal "Escazú" (la del canal). */
  locationId: string;
  serviceId: (name: string) => string;
  growth: AgentGrowth | undefined;
}

/** Siembra un negocio nuevo de `industry` como un alta real, con equipo, horario y precios de demo. */
export async function seedTemplateBusiness(db: Executor, industry: Exclude<Industry, "aesthetics">): Promise<{ businessId: string }> {
  const { business, location } = await createBusiness(
    db,
    { name: TEMPLATE_BUSINESS_NAMES[industry], industry, timezone: EVAL_TZ, currency: "CRC", country: "CR", locationName: CHANNEL_LOCATION },
    PROVISIONING_STEPS,
  );
  const businessId = business.id;
  await withTenant(db, businessId, async (tx) => {
    const team = await tx
      .insert(staff)
      .values([
        { businessId, name: "Laura Campos", color: "#e86a92", position: 0 },
        { businessId, name: "Sergio Mora", color: "#6a8ee8", position: 1 },
      ])
      .returning({ id: staff.id });
    // Sin filas en staff_services: las dos personas hacen todos los servicios.
    await tx.insert(staffHours).values(
      team.flatMap((s) =>
        DEFAULT_LOCATION_HOURS.map((h) => ({ businessId, staffId: s.id, locationId: location.id, weekday: h.weekday, startsAt: h.opensAt, endsAt: h.closesAt })),
      ),
    );
    for (const [name, colones] of Object.entries(TEMPLATE_PRICES[industry])) {
      if (colones === null) continue;
      const updated = await tx
        .update(services)
        .set({ priceCents: crc(colones) })
        .where(and(eq(services.businessId, businessId), eq(services.name, name)))
        .returning({ id: services.id });
      if (!updated.length) throw new Error(`eval: la plantilla "${industry}" ya no trae el servicio "${name}"`);
    }
  });
  return { businessId };
}

/** Prepara el negocio, el cliente y lo que el caso pide sembrar. */
export async function prepareWorld(db: Executor, c: EvalCase, now: Date): Promise<CaseWorld> {
  const template = caseTemplate(c);
  const { businessId } = template === "aesthetics" ? await seedDev(db, { now }) : await seedTemplateBusiness(db, template);
  const locationId = (await listLocations(db, businessId)).find((l) => l.name === CHANNEL_LOCATION)?.id;
  if (!locationId) throw new Error(`eval: el negocio de "${template}" no trae la sucursal ${CHANNEL_LOCATION}`);
  const catalog = await getServices(db, businessId);
  const serviceId = (name: string) => {
    const s = catalog.find((x) => x.name === name);
    if (!s) throw new Error(`eval: el negocio de "${template}" no trae el servicio "${name}"`);
    return s.id;
  };
  if (c.register) await updateAiSettings(db, { businessId, userId: null }, { register: c.register });

  const { client } = await findOrCreateClientByPhone(db, businessId, { phone: CLIENT_PHONE, name: CLIENT_NAME, source: "WhatsApp" });
  const today = localDate(now, EVAL_TZ);
  for (const s of c.seedAppointments ?? []) {
    await bookAppointment(db, businessId, {
      locationId,
      clientId: client.id,
      serviceIds: [serviceId(s.service)],
      staffId: "any",
      startsAt: zonedInstant(addDays(today, s.inDays), s.time, EVAL_TZ),
      channel: "whatsapp_ai",
      now,
    });
  }

  const growth: AgentGrowth | undefined = c.growth
    ? {
        quoteRecovery: c.growth.quoteRecovery === true,
        upsellRules: (c.growth.upsell ?? []).map((r) => ({ serviceId: serviceId(r.service), suggestServiceId: serviceId(r.suggest) })),
      }
    : undefined;
  return { businessId, clientId: client.id, locationId, serviceId, growth };
}

/** Conversación fija de la corrida (no hay fila en `conversations`: el agente no la necesita). */
export const EVAL_CONVERSATION_ID = "00000000-0000-4000-8000-0000000000e1";

/**
 * Entrada del turno: el historial del caso (de hoy, un minuto entre mensajes, terminando
 * justo antes del turno; con `byHuman` donde lo marque el caso), el mensaje del cliente, el
 * canal y el crecimiento resuelto.
 */
export function buildTurnInput(c: EvalCase, world: CaseWorld, now: Date): AgentTurnInput {
  const previous = c.history ?? [];
  const history: AgentHistoryMessage[] = [
    ...previous.map((m, i) => ({
      role: m.role,
      text: m.text,
      at: new Date(now.getTime() - (previous.length - i + 1) * 60_000),
      ...(m.byHuman ? { byHuman: true } : {}),
    })),
    { role: "user", text: c.user, at: now },
  ];
  return {
    businessId: world.businessId,
    conversationId: EVAL_CONVERSATION_ID,
    clientId: world.clientId,
    clientPhone: CLIENT_PHONE,
    clientName: CLIENT_NAME,
    locationId: c.channel === "all" ? null : world.locationId,
    history,
    now,
    ...(world.growth ? { growth: world.growth } : {}),
  };
}
