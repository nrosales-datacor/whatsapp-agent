import type { Executor } from "../../platform/db/scope";
import { HttpError } from "../../platform/http/errors";
import { formatCustomFieldValue, getBusinessContext, listCustomFields } from "../business";
import { listStaffOptions } from "../team";
import { CSV_BOM, csvLine } from "./csv";
import { iterateClients, type ClientFilters } from "./search";
import type { ClientScope } from "./service";
import type { ClientStatus } from "./status";

// ─────────────────────────────────────────────────────────────────────────────
// Exportar clientes a CSV (`GET /clients/export.csv`, CRM del Pro, dueño y admin) con los
// mismos filtros que la lista. Se genera por lotes (`iterateClients`): la ruta va
// escribiendo la respuesta sin cargar todos los clientes en memoria. Los encabezados de
// los datos de la ficha y de los campos personalizados son los que reconoce la
// importación, así el archivo se puede editar y volver a importar.
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<ClientStatus, string> = {
  new: "Nuevo",
  active: "Activo",
  vip: "VIP",
  at_risk: "En riesgo",
  inactive: "Inactivo",
};

const CHANNEL_LABELS: Record<string, string> = { whatsapp: "WhatsApp", email: "Correo" };

/** "AAAA-MM-DD" de un instante en la zona del negocio. */
function localDate(d: Date | null, timeZone: string): string {
  if (!d) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Céntimos → "25000.00" (punto decimal: lo entiende cualquier planilla al importar). */
const amount = (cents: number) => (cents / 100).toFixed(2);

/** Líneas del CSV (la primera con el BOM y los encabezados). */
export async function* exportClientsCsv(
  db: Executor,
  businessId: string,
  filters: ClientFilters,
  options: { scope?: ClientScope; now?: Date } = {},
): AsyncGenerator<string> {
  const ctx = await getBusinessContext(db, businessId);
  if (!ctx) throw new HttpError(404, "Negocio no encontrado.", "not_found");
  const tz = ctx.business.timezone;
  const [customFields, staff] = await Promise.all([listCustomFields(db, businessId, { entity: "client" }), listStaffOptions(db, businessId)]);
  const locationName = new Map(ctx.locations.map((l) => [l.id, l.name]));
  const staffName = new Map(staff.map((s) => [s.id, s.name]));
  const t = ctx.terminology;
  const cap = (s: string) => s.charAt(0).toLocaleUpperCase("es") + s.slice(1);

  yield CSV_BOM +
    csvLine([
      "Nombre",
      "Teléfono",
      "Correo",
      "Fecha de nacimiento",
      "Etiquetas",
      "Origen",
      "Notas",
      `${cap(t.location)} preferida`,
      `${cap(t.staffMember)} preferido`,
      "Recordatorios por",
      "VIP",
      "Estado",
      "Visitas",
      "Primera visita",
      "Última visita",
      `Gasto total (${ctx.business.currency})`,
      `${cap(t.client)} desde`,
      ...customFields.map((f) => f.label),
    ]);

  for await (const batch of iterateClients(db, businessId, filters, options)) {
    let chunk = "";
    for (const { row, status, isVip } of batch) {
      chunk += csvLine([
        row.name,
        row.phone,
        row.email,
        row.birthDate,
        (row.tags ?? []).join("; "),
        row.source,
        row.notes,
        row.preferredLocationId ? (locationName.get(row.preferredLocationId) ?? "") : "",
        row.preferredStaffId ? (staffName.get(row.preferredStaffId) ?? "") : "",
        row.preferredChannel ? (CHANNEL_LABELS[row.preferredChannel] ?? row.preferredChannel) : "",
        isVip ? "Sí" : "No",
        STATUS_LABELS[status],
        row.visitCount,
        localDate(row.firstVisitAt, tz),
        localDate(row.lastVisitAt, tz),
        amount(row.totalSpentCents),
        localDate(row.createdAt, tz),
        ...customFields.map((f) => formatCustomFieldValue(f, row.customData?.[f.key])),
      ]);
    }
    yield chunk;
  }
}
