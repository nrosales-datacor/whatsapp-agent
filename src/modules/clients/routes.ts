import { z } from "zod";
import { userActor } from "../../platform/audit/auditLog";
import type { Role } from "../../platform/auth/sessionToken";
import type { Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import { created, route } from "../../platform/http/router";
import type { Route } from "../../platform/http/routeTypes";
import { getBusinessContext } from "../business";
import { listStaffOptions } from "../team";
import { CLIENT_CHANNELS } from "./schema";
import { CLIENT_SORTS, DEFAULT_PAGE_SIZE, listClients, MAX_PAGE_SIZE } from "./search";
import { anonymizeClient, createClient, getClientDetail, updateClient, type ClientDataEraser } from "./service";

// ─────────────────────────────────────────────────────────────────────────────
// Rutas de clientes (I1, alcance Básico: la ficha; el CRM completo llega en I3):
//
//   GET    /clients                  lista y búsqueda (todos los roles)
//   GET    /clients/form-options     sucursales y profesionales para la ficha (todos)
//   POST   /clients                  alta (owner, admin, front_desk)
//   GET    /clients/:id              ficha (todos los roles)
//   PATCH  /clients/:id              edición (owner, admin, front_desk)
//   POST   /clients/:id/anonymize    eliminar sus datos personales (solo owner)
//
// Sin `module`: la ficha del cliente es del núcleo y viene en los dos planes. Lo del Pro
// (estados, filtros, importar CSV) declarará `module: "clients"` en I3. Por ahora el
// profesional (staff) ve todos los clientes; "solo mis clientes" llega con la Agenda.
// ─────────────────────────────────────────────────────────────────────────────

/** Dependencias de las rutas del módulo (src/routes.ts las inyecta). */
export interface ClientsRouteDeps {
  db: Executor;
  /** Borradores de datos personales de otros módulos al anonimizar (p. ej. WhatsApp, en I2). */
  clientErasers?: readonly ClientDataEraser[];
}

const EDITORS: readonly Role[] = ["owner", "admin", "front_desk"];

/** Texto: recorta espacios y deja "" como null (vaciar el campo). */
const blankToNull = (value: unknown) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};
const nullableText = (max: number) => z.preprocess(blankToNull, z.string().max(max).nullable());

const Name = z.string().trim().min(1, "Escribí el nombre.").max(120);
const Phone = z.preprocess(blankToNull, z.string().max(32).nullable());
const Email = z.preprocess(
  (v) => (typeof v === "string" ? blankToNull(v.toLowerCase()) : v),
  z.email("Correo electrónico inválido.").max(320).nullable(),
);
const BirthDate = z.preprocess(
  blankToNull,
  z.iso
    .date("Fecha inválida (formato AAAA-MM-DD).")
    .refine((d) => d >= "1900-01-01", "La fecha es demasiado antigua.")
    .refine((d) => d <= new Date().toISOString().slice(0, 10), "La fecha no puede ser futura.")
    .nullable(),
);
const Tags = z.array(z.string().trim().min(1, "Una etiqueta no puede quedar vacía.").max(40)).max(30);
const OptionalId = z.preprocess(blankToNull, z.uuid().nullable());
const Channel = z.preprocess(blankToNull, z.enum(CLIENT_CHANNELS).nullable());

const ClientFields = {
  name: Name,
  phone: Phone,
  email: Email,
  birthDate: BirthDate,
  notes: nullableText(5000),
  tags: Tags,
  preferredLocationId: OptionalId,
  preferredStaffId: OptionalId,
  preferredChannel: Channel,
  guardianId: OptionalId,
};

const CreateBody = z.object({
  ...ClientFields,
  phone: ClientFields.phone.optional(),
  email: ClientFields.email.optional(),
  birthDate: ClientFields.birthDate.optional(),
  notes: ClientFields.notes.optional(),
  tags: ClientFields.tags.optional(),
  preferredLocationId: ClientFields.preferredLocationId.optional(),
  preferredStaffId: ClientFields.preferredStaffId.optional(),
  preferredChannel: ClientFields.preferredChannel.optional(),
  guardianId: ClientFields.guardianId.optional(),
  source: nullableText(60).optional(),
});

const PatchBody = z
  .object({
    name: ClientFields.name.optional(),
    phone: ClientFields.phone.optional(),
    email: ClientFields.email.optional(),
    birthDate: ClientFields.birthDate.optional(),
    notes: ClientFields.notes.optional(),
    tags: ClientFields.tags.optional(),
    preferredLocationId: ClientFields.preferredLocationId.optional(),
    preferredStaffId: ClientFields.preferredStaffId.optional(),
    preferredChannel: ClientFields.preferredChannel.optional(),
    guardianId: ClientFields.guardianId.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "Indicá qué cambiar." });

const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  sort: z.enum(CLIENT_SORTS).default("name"),
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

const ClientParams = z.object({ id: z.uuid() });
const AnonymizeBody = z.object({ confirmation: z.string().trim().min(1, "Escribí la confirmación.").max(200) });

export function clientsRoutes({ db, clientErasers = [] }: ClientsRouteDeps): Route[] {
  return [
    route({ method: "GET", path: "/clients", auth: "user", query: ListQuery }, ({ session, query }) =>
      listClients(db, session.businessId, query),
    ),

    // Opciones de la ficha: TODAS las sucursales activas del negocio (no solo las del
    // usuario: el preferido puede ser otra) y los profesionales.
    route({ method: "GET", path: "/clients/form-options", auth: "user" }, async ({ session }) => {
      const [ctx, staff] = await Promise.all([getBusinessContext(db, session.businessId), listStaffOptions(db, session.businessId)]);
      if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
      return {
        locations: ctx.locations.map((l) => ({ id: l.id, name: l.name, active: l.active })),
        staff,
      };
    }),

    route({ method: "POST", path: "/clients", auth: "user", roles: EDITORS, body: CreateBody }, async ({ session, body }) =>
      created(
        await createClient(db, session.businessId, {
          name: body.name,
          phone: body.phone ?? null,
          email: body.email ?? null,
          birthDate: body.birthDate ?? null,
          notes: body.notes ?? null,
          tags: body.tags ?? [],
          source: body.source ?? null,
          preferredLocationId: body.preferredLocationId ?? null,
          preferredStaffId: body.preferredStaffId ?? null,
          preferredChannel: body.preferredChannel ?? null,
          guardianId: body.guardianId ?? null,
        }),
      ),
    ),

    route({ method: "GET", path: "/clients/:id", auth: "user", params: ClientParams }, ({ session, params }) =>
      getClientDetail(db, session.businessId, params.id),
    ),

    route(
      { method: "PATCH", path: "/clients/:id", auth: "user", roles: EDITORS, params: ClientParams, body: PatchBody },
      async ({ session, params, body }) => {
        await updateClient(db, session.businessId, params.id, body);
        return getClientDetail(db, session.businessId, params.id);
      },
    ),

    route(
      { method: "POST", path: "/clients/:id/anonymize", auth: "user", roles: ["owner"], params: ClientParams, body: AnonymizeBody },
      async ({ session, params, body, log }) => {
        const client = await anonymizeClient(db, session.businessId, params.id, {
          actor: userActor(session.userId),
          confirmation: body.confirmation,
          erasers: clientErasers,
        });
        log.info("client_anonymized", { clientId: client.id });
        return getClientDetail(db, session.businessId, client.id);
      },
    ),
  ];
}
