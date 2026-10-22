import { once } from "node:events";
import type { SQL } from "drizzle-orm";
import { z } from "zod";
import { userActor } from "../../platform/audit/auditLog";
import type { Role } from "../../platform/auth/sessionToken";
import type { Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import { created, route } from "../../platform/http/router";
import type { Route, Session } from "../../platform/http/routeTypes";
import { assertFullClients, hasFullClients, type ClientsTierHook } from "../../platform/plan/planHooks";
import { CustomDataInput, getBusinessContext } from "../business";
import { getStaffIdForUser, listStaffOptions } from "../team";
import { exportClientsCsv } from "./exporter";
import { importClients, MAX_IMPORT_ROWS } from "./importer";
import { CLIENT_CHANNELS } from "./schema";
import { CLIENT_SORTS, countClientsByStatus, DEFAULT_PAGE_SIZE, listClients, listClientTags, MAX_PAGE_SIZE, usesCrmFilters, type ClientFilters } from "./search";
import { anonymizeClient, clientIdIn, createClient, getClientDetail, updateClient, type ClientDataEraser, type ClientScope } from "./service";
import { CLIENT_STATUSES } from "./status";

// ─────────────────────────────────────────────────────────────────────────────
// Rutas de clientes. La ficha es del núcleo (los dos planes); el CRM completo (estados,
// filtros, VIP, campos personalizados, importar y exportar) es del nivel `full` de clientes
// (plan Pro): sin él responde 403 `module_not_in_plan`.
//
//   GET    /clients                  lista y búsqueda (todos). Filtros del CRM y orden por
//                                    gasto o visitas: Pro. En Pro cada fila trae su estado.
//   GET    /clients/status-counts    cantidad por estado con los filtros: los chips (todos; Pro)
//   GET    /clients/tags             etiquetas en uso, para el filtro (todos; Pro)
//   GET    /clients/export.csv       CSV con los filtros (dueño, admin; Pro)
//   POST   /clients/import           vista previa / importación de un CSV (dueño, admin; Pro)
//   GET    /clients/form-options     sucursales y profesionales para la ficha (todos)
//   POST   /clients                  alta (dueño, admin, recepción; `vip`/`customData`: Pro)
//   GET    /clients/:id              ficha (todos; en Pro con estado y VIP calculados)
//   PATCH  /clients/:id              edición (dueño, admin, recepción; `vip`/`customData`: Pro)
//   POST   /clients/:id/anonymize    eliminar sus datos personales (solo dueño)
//
// "Mis clientes" (rol `staff`, en cualquier plan): el profesional solo ve los clientes con
// citas suyas, pasadas o futuras (no cuentan las canceladas), y en solo lectura. La
// subconsulta de esas citas la arma scheduling (dueño de `appointments`) y la inyecta la
// composición (src/routes.ts); sin ella, el profesional no ve ningún cliente.
// ─────────────────────────────────────────────────────────────────────────────

/** Subconsulta con los ids de los clientes que tienen citas con este profesional. */
export type StaffClientsQuery = (businessId: string, staffId: string) => SQL;

/** Dependencias de las rutas del módulo (src/routes.ts las inyecta). */
export interface ClientsRouteDeps {
  db: Executor;
  /** Nivel de clientes del plan (CRM completo = `full`). */
  plans: ClientsTierHook;
  /** Borradores de datos personales de otros módulos al anonimizar (p. ej. WhatsApp). */
  clientErasers?: readonly ClientDataEraser[];
  /** "Mis clientes" del profesional (la subconsulta la arma scheduling). */
  staffClients?: StaffClientsQuery;
}

const EDITORS: readonly Role[] = ["owner", "admin", "front_desk"];
const MANAGERS: readonly Role[] = ["owner", "admin"];

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
  vip: z.boolean().optional(),
  customData: CustomDataInput.optional(),
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
    vip: z.boolean().optional(),
    customData: CustomDataInput.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "Indicá qué cambiar." });

// ── Filtros (query) ─────────────────────────────────────────────────────────

/** Valor repetido (`?tag=a&tag=b`) o separado por comas (`?status=new,vip`) → lista. */
const listParam = (splitCommas: boolean) => (v: unknown) => {
  if (v === undefined || v === "") return undefined;
  const values = Array.isArray(v) ? v : [v];
  return values.flatMap((x) => (typeof x === "string" ? (splitCommas ? x.split(",") : [x]) : [x])).map((x) => (typeof x === "string" ? x.trim() : x)).filter((x) => x !== "");
};
const BoolParam = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

/**
 * Filtros de la lista en la query string (`GET /clients`, `/clients/status-counts`,
 * `/clients/export.csv`). API pública: Campañas (I6) la reusa para sus segmentos.
 */
export const ClientFiltersQuery = z
  .object({
    q: z.string().trim().max(100).optional(),
    status: z.preprocess(listParam(true), z.array(z.enum(CLIENT_STATUSES)).max(CLIENT_STATUSES.length).optional()),
    tag: z.preprocess(listParam(false), z.array(z.string().trim().min(1).max(40)).max(20).optional()),
    lastVisitFrom: z.iso.date("Fecha inválida (formato AAAA-MM-DD).").optional(),
    lastVisitTo: z.iso.date("Fecha inválida (formato AAAA-MM-DD).").optional(),
    preferredStaffId: z.uuid().optional(),
    preferredLocationId: z.uuid().optional(),
    vip: BoolParam.optional(),
  })
  .refine((f) => !f.lastVisitFrom || !f.lastVisitTo || f.lastVisitFrom <= f.lastVisitTo, {
    message: "El inicio del rango tiene que ser antes del fin.",
    path: ["lastVisitTo"],
  });

type FiltersQuery = z.output<typeof ClientFiltersQuery>;

/** Query → filtros del servicio. */
export function filtersFromQuery(q: FiltersQuery): ClientFilters {
  return {
    q: q.q,
    statuses: q.status,
    tags: q.tag,
    lastVisitFrom: q.lastVisitFrom,
    lastVisitTo: q.lastVisitTo,
    preferredStaffId: q.preferredStaffId,
    preferredLocationId: q.preferredLocationId,
    vip: q.vip,
  };
}

const ListQuery = z.intersection(
  ClientFiltersQuery,
  z.object({
    sort: z.enum(CLIENT_SORTS).default("name"),
    cursor: z.string().max(1000).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  }),
);

const ClientParams = z.object({ id: z.uuid() });
const AnonymizeBody = z.object({ confirmation: z.string().trim().min(1, "Escribí la confirmación.").max(200) });

/** Tope del CSV a importar (caracteres) y del cuerpo JSON que lo trae. */
const MAX_IMPORT_CSV_CHARS = 2_000_000;
const IMPORT_MAX_BODY_BYTES = 5 * 1024 * 1024;

const ImportBody = z
  .object({
    csv: z.string().min(1, "Subí un archivo.").max(MAX_IMPORT_CSV_CHARS, `El archivo es demasiado grande (máximo 2 MB o ${MAX_IMPORT_ROWS} filas).`),
    hasHeader: z.boolean().nullable().optional(),
    mapping: z
      .record(z.string().regex(/^\d{1,3}$/), z.string().max(80).nullable())
      .nullable()
      .optional(),
    onExisting: z.enum(["update", "skip"]).optional(),
    commit: z.boolean().optional(),
  })
  .strict();

/** Nombre del archivo exportado: "pacientes-2026-10-22.csv" (solo ASCII). */
function exportFileName(term: string, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const base =
    term
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "clientes";
  return `${base}-${day}.csv`;
}

export function clientsRoutes({ db, plans, clientErasers = [], staffClients }: ClientsRouteDeps): Route[] {
  /** Alcance de la sesión: el profesional, solo sus clientes. */
  async function scopeFor(session: Session): Promise<ClientScope> {
    if (session.role !== "staff") return undefined;
    const staffId = await getStaffIdForUser(db, session.businessId, session.userId);
    if (!staffId || !staffClients) return "none";
    return clientIdIn(staffClients(session.businessId, staffId));
  }

  return [
    route({ method: "GET", path: "/clients", auth: "user", query: ListQuery }, async ({ session, query }) => {
      const crm = await hasFullClients(plans, session.businessId);
      const input = { ...filtersFromQuery(query), sort: query.sort, cursor: query.cursor, limit: query.limit };
      if (!crm && usesCrmFilters(input)) await assertFullClients(plans, session.businessId);
      return listClients(db, session.businessId, input, { scope: await scopeFor(session), withStatus: crm });
    }),

    route({ method: "GET", path: "/clients/status-counts", auth: "user", query: ClientFiltersQuery }, async ({ session, query }) => {
      await assertFullClients(plans, session.businessId);
      return countClientsByStatus(db, session.businessId, filtersFromQuery(query), { scope: await scopeFor(session) });
    }),

    route({ method: "GET", path: "/clients/tags", auth: "user" }, async ({ session }) => {
      await assertFullClients(plans, session.businessId);
      return listClientTags(db, session.businessId, { scope: await scopeFor(session) });
    }),

    route(
      { method: "GET", path: "/clients/export.csv", auth: "user", roles: MANAGERS, query: ClientFiltersQuery },
      async ({ session, query, res, log }) => {
        await assertFullClients(plans, session.businessId);
        const ctx = await getBusinessContext(db, session.businessId);
        if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
        const lines = exportClientsCsv(db, session.businessId, filtersFromQuery(query));
        // La primera línea (encabezados) se arma antes de responder: si algo falla, sale el error en JSON.
        const first = await lines.next();
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${exportFileName(ctx.terminology.clients, ctx.business.timezone)}"`,
        });
        let rows = 0;
        if (!first.done) res.write(first.value);
        for await (const chunk of lines) {
          rows += chunk.split("\r\n").length - 1;
          if (!res.write(chunk)) await once(res, "drain");
        }
        res.end();
        log.info("clients_exported", { rows });
      },
    ),

    route(
      { method: "POST", path: "/clients/import", auth: "user", roles: MANAGERS, body: ImportBody, maxBodyBytes: IMPORT_MAX_BODY_BYTES },
      async ({ session, body, log }) => {
        await assertFullClients(plans, session.businessId);
        const report = await importClients(db, session.businessId, {
          csv: body.csv,
          hasHeader: body.hasHeader,
          mapping: body.mapping,
          onExisting: body.onExisting,
          commit: body.commit,
          actor: userActor(session.userId),
        });
        if (report.committed) log.info("clients_imported", { ...report.summary });
        return report;
      },
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

    route({ method: "POST", path: "/clients", auth: "user", roles: EDITORS, body: CreateBody }, async ({ session, body }) => {
      const crm = await hasFullClients(plans, session.businessId);
      if (!crm && (body.vip !== undefined || body.customData !== undefined)) await assertFullClients(plans, session.businessId);
      const client = await createClient(db, session.businessId, {
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
        vip: body.vip,
        customData: body.customData,
      });
      return created(await getClientDetail(db, session.businessId, client.id, { crm }));
    }),

    route({ method: "GET", path: "/clients/:id", auth: "user", params: ClientParams }, async ({ session, params }) =>
      getClientDetail(db, session.businessId, params.id, { crm: await hasFullClients(plans, session.businessId), scope: await scopeFor(session) }),
    ),

    route(
      { method: "PATCH", path: "/clients/:id", auth: "user", roles: EDITORS, params: ClientParams, body: PatchBody },
      async ({ session, params, body }) => {
        const crm = await hasFullClients(plans, session.businessId);
        if (!crm && (body.vip !== undefined || body.customData !== undefined)) await assertFullClients(plans, session.businessId);
        await updateClient(db, session.businessId, params.id, body);
        return getClientDetail(db, session.businessId, params.id, { crm });
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
