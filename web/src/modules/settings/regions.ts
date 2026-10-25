// Países, zonas horarias y monedas que ofrece Configuración (los mercados de hoy). Si el
// negocio ya tiene un valor que no está en la lista, el formulario lo agrega como opción.

export const COUNTRY_OPTIONS = [
  { value: "CR", label: "Costa Rica" },
  { value: "PA", label: "Panamá" },
  { value: "NI", label: "Nicaragua" },
  { value: "HN", label: "Honduras" },
  { value: "SV", label: "El Salvador" },
  { value: "GT", label: "Guatemala" },
  { value: "MX", label: "México" },
  { value: "CO", label: "Colombia" },
] as const;

export const TIMEZONE_OPTIONS = [
  "America/Costa_Rica",
  "America/Panama",
  "America/Managua",
  "America/Tegucigalpa",
  "America/El_Salvador",
  "America/Guatemala",
  "America/Mexico_City",
  "America/Bogota",
].map((tz) => ({ value: tz, label: tz.replace("America/", "").replace(/_/g, " ") }));

export const CURRENCY_OPTIONS = [
  { value: "CRC", label: "CRC · colón" },
  { value: "USD", label: "USD · dólar" },
  { value: "NIO", label: "NIO · córdoba" },
  { value: "HNL", label: "HNL · lempira" },
  { value: "GTQ", label: "GTQ · quetzal" },
  { value: "MXN", label: "MXN · peso mexicano" },
  { value: "COP", label: "COP · peso colombiano" },
];

/** Opciones con el valor actual incluido aunque no esté en la lista. */
export function withCurrent<T extends { value: string; label: string }>(options: readonly T[], current: string): { value: string; label: string }[] {
  return options.some((o) => o.value === current) || !current ? [...options] : [{ value: current, label: current }, ...options];
}

/** Zona horaria y moneda con que arranca un negocio de cada país (el alta self-service las toma de acá). */
export const COUNTRY_DEFAULTS: Readonly<Record<string, { timezone: string; currency: string }>> = {
  CR: { timezone: "America/Costa_Rica", currency: "CRC" },
  PA: { timezone: "America/Panama", currency: "USD" },
  NI: { timezone: "America/Managua", currency: "NIO" },
  HN: { timezone: "America/Tegucigalpa", currency: "HNL" },
  SV: { timezone: "America/El_Salvador", currency: "USD" },
  GT: { timezone: "America/Guatemala", currency: "GTQ" },
  MX: { timezone: "America/Mexico_City", currency: "MXN" },
  CO: { timezone: "America/Bogota", currency: "COP" },
};
