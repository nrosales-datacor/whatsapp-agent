import { promises as dns } from "node:dns";

// ─────────────────────────────────────────────────────────────────────────────
// "¿Este correo puede recibir mail?" para el alta self-service (anti-abuso sin CAPTCHA):
//
//   1. Dominio con forma de dominio público (no una IP, no `.test`/`.local`/`.example`…).
//   2. No es un proveedor de correo descartable conocido.
//   3. DNS: el dominio tiene servidor de correo (MX, o A/AAAA como MX implícito, RFC 5321);
//      un MX nulo (RFC 7505) dice que NO recibe correo.
//
// El DNS falla ABIERTO: un timeout o un error del resolver no frena a una persona real (el
// correo de verificación igual tiene que llegar para usar la cuenta). Solo "el dominio no
// existe" o "no recibe correo" cuentan como inválido. SIGNUP_EMAIL_DNS_CHECK=0 apaga el
// paso 3 (p. ej. desarrollo sin red). El resolver es inyectable para los tests.
// ─────────────────────────────────────────────────────────────────────────────

export type EmailDomainProblem = "invalid" | "reserved" | "disposable" | "no_mail_server";

export type EmailDomainResult = { ok: true } | { ok: false; problem: EmailDomainProblem };

/** Resolver DNS mínimo: MX y direcciones del dominio (lanza con `code` como `node:dns`). */
export interface MailDnsResolver {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolveAddresses(domain: string): Promise<string[]>;
}

/** TLDs y dominios reservados que nunca reciben correo real (RFC 2606 / 6761 y afines). */
const RESERVED_TLDS = new Set(["test", "example", "invalid", "localhost", "local", "internal", "lan", "home", "onion"]);
const RESERVED_DOMAINS = new Set(["example.com", "example.net", "example.org"]);

/** Proveedores de correo descartable más comunes (la lista no pretende ser completa). */
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "sharklasers.com",
  "grr.la",
  "10minutemail.com",
  "10minutemail.net",
  "tempmail.com",
  "temp-mail.org",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "yopmail.com",
  "yopmail.net",
  "getnada.com",
  "nada.email",
  "dispostable.com",
  "maildrop.cc",
  "mailnesia.com",
  "trashmail.com",
  "trashmail.de",
  "fakeinbox.com",
  "mohmal.com",
  "emailondeck.com",
  "mintemail.com",
  "spamgourmet.com",
  "mailcatch.com",
  "moakt.com",
  "burnermail.io",
  "inboxkitten.com",
]);

const RE_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Dominio del correo en minúsculas, o null si no tiene forma de dominio público. */
export function emailDomainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  if (domain.length < 4 || domain.length > 253 || domain.startsWith("[")) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => RE_LABEL.test(l))) return null;
  // El TLD es alfabético (o un IDN `xn--`): `10.0.0.1` no es un dominio.
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,63}$/.test(tld) && !tld.startsWith("xn--")) return null;
  return domain;
}

const nodeResolver: MailDnsResolver = {
  resolveMx: (domain) => dns.resolveMx(domain),
  resolveAddresses: async (domain) => {
    const [v4, v6] = await Promise.allSettled([dns.resolve4(domain), dns.resolve6(domain)]);
    const out = [...(v4.status === "fulfilled" ? v4.value : []), ...(v6.status === "fulfilled" ? v6.value : [])];
    if (out.length > 0) return out;
    // Si las dos fallaron, se propaga el error de la primera (con su `code`).
    if (v4.status === "rejected") throw v4.reason;
    return out;
  },
};

/** Códigos de `node:dns` que dicen "no existe / no tiene ese registro" (no un fallo del resolver). */
const NOT_FOUND_CODES = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export interface EmailDomainOptions {
  resolver?: MailDnsResolver;
  /** false = sin consulta DNS. Default: SIGNUP_EMAIL_DNS_CHECK (todo menos "0"). */
  dnsCheck?: boolean;
  timeoutMs?: number;
}

export async function checkEmailDomain(email: string, options: EmailDomainOptions = {}): Promise<EmailDomainResult> {
  const domain = emailDomainOf(email);
  if (!domain) return { ok: false, problem: "invalid" };
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (RESERVED_TLDS.has(tld) || RESERVED_DOMAINS.has(domain)) return { ok: false, problem: "reserved" };
  if (DISPOSABLE_DOMAINS.has(domain) || [...DISPOSABLE_DOMAINS].some((d) => domain.endsWith(`.${d}`))) {
    return { ok: false, problem: "disposable" };
  }

  const dnsCheck = options.dnsCheck ?? process.env.SIGNUP_EMAIL_DNS_CHECK?.trim() !== "0";
  if (!dnsCheck) return { ok: true };
  const resolver = options.resolver ?? nodeResolver;
  const timeoutMs = options.timeoutMs ?? 3000;

  try {
    const mx = await withTimeout(resolver.resolveMx(domain), timeoutMs);
    if (mx === "timeout") return { ok: true };
    const exchanges = mx.map((r) => r.exchange.replace(/\.$/, "")).filter((e) => e.length > 0);
    if (mx.length > 0 && exchanges.length === 0) return { ok: false, problem: "no_mail_server" }; // MX nulo
    if (exchanges.length > 0) return { ok: true };
  } catch (error) {
    if (!NOT_FOUND_CODES.has(codeOf(error) ?? "")) return { ok: true }; // falla abierto
    if (codeOf(error) === "ENOTFOUND" || codeOf(error) === "NXDOMAIN") return { ok: false, problem: "no_mail_server" };
  }
  // Sin MX: vale un A/AAAA (MX implícito).
  try {
    const addresses = await withTimeout(resolver.resolveAddresses(domain), timeoutMs);
    if (addresses === "timeout") return { ok: true };
    return addresses.length > 0 ? { ok: true } : { ok: false, problem: "no_mail_server" };
  } catch (error) {
    return NOT_FOUND_CODES.has(codeOf(error) ?? "") ? { ok: false, problem: "no_mail_server" } : { ok: true };
  }
}

/** Mensaje para el campo del formulario (no revela nada de las cuentas). */
export function emailDomainMessage(problem: EmailDomainProblem): string {
  switch (problem) {
    case "disposable":
      return "Usá un correo permanente: los correos descartables no sirven para recuperar la cuenta.";
    case "reserved":
    case "invalid":
      return "Escribí un correo válido.";
    case "no_mail_server":
      return "Ese dominio no recibe correos: revisá cómo lo escribiste.";
  }
}
