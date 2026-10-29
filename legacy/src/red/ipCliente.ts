import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";

// ─────────────────────────────────────────────────────────────────────────────
// IP real del cliente detrás de un proxy (revisión de seguridad pre-venta 2026-10).
//
// Antes el rate limit de login tomaba el PRIMER valor de `X-Forwarded-For` sin
// preguntarse quién lo había puesto: ese header lo manda el cliente, así que un
// atacante lo rotaba en cada request ("X-Forwarded-For: 1.1.1.1", "2.2.2.2", …) y el
// límite por IP no lo frenaba nunca.
//
// Regla nueva: solo se cree lo que agregaron proxies DE CONFIANZA, y se lee de derecha
// a izquierda (cada proxy AGREGA al final la IP de quien le habló). La IP del cliente es
// el último salto que NO es un proxy de confianza. Configuración por env `TRUST_PROXY`:
//
//   • sin definir / vacío  → no hay proxy de confianza: se usa la IP del socket y se
//                            ignora `X-Forwarded-For` por completo.
//   • un número N (ej. 1)  → hay exactamente N proxies delante (Caddy/nginx en el mismo
//                            droplet = 1). Se toma el salto N contando desde el socket.
//   • lista de IPs / CIDR  → ej. "loopback" o "127.0.0.1,::1,10.0.0.0/8". Se recorre la
//                            cadena desde el socket hacia atrás mientras el salto sea de
//                            confianza; el primero que no lo es, es el cliente.
//                            `loopback` = 127.0.0.0/8 + ::1.
//
// Con Caddy o nginx en el mismo servidor (DEPLOY.md §8) lo correcto es
// `TRUST_PROXY=loopback`. Sin la env, detrás de un proxy local TODOS los clientes se
// ven como 127.0.0.1 — el límite por IP pasa a ser uno solo para todo el mundo — así
// que se avisa por consola la primera vez que se detecta esa situación.
// ─────────────────────────────────────────────────────────────────────────────

type Confianza = { tipo: "ninguna" } | { tipo: "saltos"; n: number } | { tipo: "lista"; lista: BlockList };

let envCacheada: string | undefined | null = null; // null = todavía sin leer
let confianza: Confianza = { tipo: "ninguna" };
let avisado = false;

/** Normaliza IPv4 mapeada en IPv6 ("::ffff:1.2.3.4" → "1.2.3.4") y recorta espacios/corchetes. */
export function normalizarIp(ip: string): string {
  let s = ip.trim();
  if (s.startsWith("[") && s.includes("]")) s = s.slice(1, s.indexOf("]"));
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s)) s = s.slice(7);
  return s;
}

function parsearConfianza(raw: string | undefined): Confianza {
  const v = (raw ?? "").trim();
  if (!v || v === "0" || v.toLowerCase() === "false") return { tipo: "ninguna" };
  if (/^\d+$/.test(v)) return { tipo: "saltos", n: Number(v) };
  const lista = new BlockList();
  for (const parte of v.split(",").map((p) => p.trim()).filter(Boolean)) {
    if (parte.toLowerCase() === "loopback") {
      lista.addSubnet("127.0.0.0", 8, "ipv4");
      lista.addAddress("::1", "ipv6");
      continue;
    }
    const [dir, mascara] = parte.split("/");
    const ip = normalizarIp(dir);
    const fam = isIP(ip);
    if (!fam) {
      console.warn(`[red] TRUST_PROXY: "${parte}" no es una IP/CIDR válida — se ignora.`);
      continue;
    }
    const tipo = fam === 4 ? "ipv4" : "ipv6";
    if (mascara !== undefined) lista.addSubnet(ip, Number(mascara), tipo);
    else lista.addAddress(ip, tipo);
  }
  return { tipo: "lista", lista };
}

function config(): Confianza {
  // Se relee si cambió la env (tests) — en producción se parsea una sola vez.
  const actual = process.env.TRUST_PROXY;
  if (envCacheada === null || envCacheada !== actual) {
    envCacheada = actual;
    confianza = parsearConfianza(actual);
  }
  return confianza;
}

function esDeConfianza(ip: string, lista: BlockList): boolean {
  const fam = isIP(ip);
  if (!fam) return false;
  return lista.check(ip, fam === 4 ? "ipv4" : "ipv6");
}

function esLoopbackOPrivada(ip: string): boolean {
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || ip === "::1";
}

/**
 * IP del cliente para rate limiting y auditoría. Nunca confía en `X-Forwarded-For`
 * salvo que `TRUST_PROXY` diga cuántos/cuáles proxies hay delante (ver cabecera).
 */
export function ipDelCliente(req: IncomingMessage): string {
  const socket = normalizarIp(req.socket?.remoteAddress ?? "") || "desconocida";
  const xffCrudo = req.headers["x-forwarded-for"];
  const xff = (Array.isArray(xffCrudo) ? xffCrudo.join(",") : (xffCrudo ?? ""))
    .split(",")
    .map(normalizarIp)
    .filter(Boolean);

  const c = config();
  if (c.tipo === "ninguna") {
    if (!avisado && xff.length && esLoopbackOPrivada(socket)) {
      avisado = true;
      console.warn(
        "[red] Llegan requests con X-Forwarded-For desde un proxy local pero TRUST_PROXY no está definido: " +
          "todos los clientes se ven con la IP del proxy y el rate limit de login es uno solo para todos. " +
          "Definí TRUST_PROXY=loopback (ver DEPLOY.md).",
      );
    }
    return socket;
  }

  // Cadena completa: lo que vino en el header + el socket (el salto más cercano).
  const cadena = [...xff, socket];
  if (c.tipo === "saltos") {
    const i = cadena.length - 1 - c.n;
    return cadena[Math.max(0, i)];
  }
  for (let i = cadena.length - 1; i >= 0; i--) {
    if (!esDeConfianza(cadena[i], c.lista)) return cadena[i];
  }
  return cadena[0]; // todos los saltos son de confianza: el más lejano es el cliente
}
