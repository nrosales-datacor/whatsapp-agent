// ─────────────────────────────────────────────────────────────────────────────
// Teléfonos de clientes en E.164 ("+50688887777"), a mano y sin dependencias (la política
// de dependencias de CLAUDE.md; libphonenumber pesa ~150 KB y acá alcanza con la longitud
// del número nacional de cada país donde vendemos).
//
//   • Con "+" (o con el prefijo internacional "00"): se toma como internacional. Si el
//     código de país es uno de la tabla, se exige la longitud nacional de ese país; si no,
//     la regla general de E.164 (7 a 15 dígitos, sin empezar en 0).
//   • Sin "+": número LOCAL del país del negocio (Costa Rica si no hay). Se acepta también
//     con el código de país pero sin el "+" ("50688887777", así llegan los números de
//     WhatsApp) y con el prefijo troncal "0" en los países que lo usan.
//
// No se valida el operador ni el primer dígito (un fijo, un móvil y los números de prueba
// del seed con prefijo 0 pasan igual): el objetivo es guardar SIEMPRE la misma forma para
// que el teléfono sea único por negocio y el agente encuentre al cliente.
// ─────────────────────────────────────────────────────────────────────────────

interface NumberingPlan {
  /** Código de país, sin "+". */
  callingCode: string;
  /** Longitudes válidas del número nacional (sin código de país ni prefijo troncal). */
  lengths: readonly number[];
  /** Longitudes extra aceptadas solo en forma internacional (MX y AR: el "1"/"9" de móvil que manda WhatsApp). */
  internationalLengths?: readonly number[];
  /** Prefijo troncal que se marca dentro del país y no va en E.164. */
  trunkPrefix?: string;
}

/** Países donde vendemos (y vecinos), por código ISO 3166-1 alfa-2 (`businesses.country`). */
const PLANS: Readonly<Record<string, NumberingPlan>> = {
  CR: { callingCode: "506", lengths: [8] },
  PA: { callingCode: "507", lengths: [7, 8] },
  NI: { callingCode: "505", lengths: [8] },
  HN: { callingCode: "504", lengths: [8] },
  SV: { callingCode: "503", lengths: [8] },
  GT: { callingCode: "502", lengths: [8] },
  BZ: { callingCode: "501", lengths: [7] },
  MX: { callingCode: "52", lengths: [10], internationalLengths: [11] },
  CO: { callingCode: "57", lengths: [10] },
  VE: { callingCode: "58", lengths: [10], trunkPrefix: "0" },
  EC: { callingCode: "593", lengths: [8, 9], trunkPrefix: "0" },
  PE: { callingCode: "51", lengths: [8, 9], trunkPrefix: "0" },
  BO: { callingCode: "591", lengths: [8], trunkPrefix: "0" },
  CL: { callingCode: "56", lengths: [9] },
  AR: { callingCode: "54", lengths: [10], internationalLengths: [11], trunkPrefix: "0" },
  UY: { callingCode: "598", lengths: [8], trunkPrefix: "0" },
  PY: { callingCode: "595", lengths: [9], trunkPrefix: "0" },
  DO: { callingCode: "1", lengths: [10] },
  PR: { callingCode: "1", lengths: [10] },
  US: { callingCode: "1", lengths: [10] },
  CA: { callingCode: "1", lengths: [10] },
  ES: { callingCode: "34", lengths: [9] },
};

/** País por defecto cuando el negocio no tiene uno conocido. */
export const DEFAULT_PHONE_COUNTRY = "CR";

// Lo que una persona escribe en un teléfono: dígitos, "+", espacios y separadores comunes.
const RE_ALLOWED = /^\+?[\d\s().\-/]+$/;
// Regla general de E.164 (también la del CHECK `clients_phone_check`).
const RE_E164_DIGITS = /^[1-9]\d{6,14}$/;

/** Plan del código de país con el que empiezan estos dígitos (el más largo que calce). */
function planForInternational(digits: string): NumberingPlan | null {
  let best: NumberingPlan | null = null;
  for (const plan of Object.values(PLANS)) {
    if (digits.startsWith(plan.callingCode) && (!best || plan.callingCode.length > best.callingCode.length)) best = plan;
  }
  return best;
}

function internationalOrNull(digits: string): string | null {
  if (!RE_E164_DIGITS.test(digits)) return null;
  const plan = planForInternational(digits);
  if (plan) {
    const national = digits.length - plan.callingCode.length;
    const valid = plan.lengths.includes(national) || (plan.internationalLengths ?? []).includes(national);
    if (!valid) return null;
  }
  return `+${digits}`;
}

/**
 * Normaliza un teléfono a E.164 con `country` (ISO alfa-2 del negocio) como país de los
 * números locales. Devuelve null si no es un teléfono válido.
 *
 * ```ts
 * normalizePhone("8888-7777", "CR")      // "+50688887777"
 * normalizePhone("+1 (305) 555-0100")    // "+13055550100"
 * normalizePhone("50688887777", "CR")    // "+50688887777" (forma de WhatsApp)
 * ```
 */
export function normalizePhone(input: string, country: string = DEFAULT_PHONE_COUNTRY): string | null {
  const raw = input.trim();
  if (!raw || !RE_ALLOWED.test(raw)) return null;
  let digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) return internationalOrNull(digits);
  if (digits.startsWith("00")) return internationalOrNull(digits.slice(2));

  const plan = PLANS[country.toUpperCase()];
  // País sin plan conocido: un número local es ambiguo, se pide el código de país.
  if (!plan) return null;
  const { callingCode, lengths, trunkPrefix } = plan;
  if (trunkPrefix && digits.startsWith(trunkPrefix) && lengths.includes(digits.length - trunkPrefix.length)) {
    digits = digits.slice(trunkPrefix.length);
  }
  if (lengths.includes(digits.length)) return `+${callingCode}${digits}`;
  // Con el código de país pero sin "+" (así llegan los números de WhatsApp).
  if (digits.startsWith(callingCode)) return internationalOrNull(digits);
  return null;
}

/** Dígitos de lo que alguien escribió en un buscador ("8888-77" → "888877"). */
export function phoneDigits(input: string): string {
  return input.replace(/\D/g, "");
}
