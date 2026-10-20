import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";

// ─────────────────────────────────────────────────────────────────────────────
// IP real del cliente detrás de un proxy.
//
// Antes el rate limit de login tomaba el PRIMER valor de `X-Forwarded-For` sin
// preguntarse quién lo había puesto: ese header lo manda el cliente, así que un atacante
// lo rotaba en cada request ("X-Forwarded-For: 1.1.1.1", "2.2.2.2", …) y el límite por IP
// no lo frenaba nunca.
//
// Regla: solo se cree lo que agregaron proxies DE CONFIANZA, y se lee de derecha a
// izquierda (cada proxy AGREGA al final la IP de quien le habló). La IP del cliente es el
// último salto que NO es un proxy de confianza. Configuración por env `TRUST_PROXY`:
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
// `TRUST_PROXY=loopback`. Sin la env, detrás de un proxy local TODOS los clientes se ven
// como 127.0.0.1 — el límite por IP pasa a ser uno solo para todo el mundo — así que se
// avisa por consola la primera vez que se detecta esa situación.
// ─────────────────────────────────────────────────────────────────────────────

type Trust = { kind: "none" } | { kind: "hops"; n: number } | { kind: "list"; list: BlockList };

let cachedEnv: string | undefined | null = null; // null = todavía sin leer
let trust: Trust = { kind: "none" };
let warned = false;

/** Normaliza IPv4 mapeada en IPv6 ("::ffff:1.2.3.4" → "1.2.3.4") y recorta espacios/corchetes. */
export function normalizeIp(ip: string): string {
  let s = ip.trim();
  if (s.startsWith("[") && s.includes("]")) s = s.slice(1, s.indexOf("]"));
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s)) s = s.slice(7);
  return s;
}

function parseTrust(raw: string | undefined): Trust {
  const v = (raw ?? "").trim();
  if (!v || v === "0" || v.toLowerCase() === "false") return { kind: "none" };
  if (/^\d+$/.test(v)) return { kind: "hops", n: Number(v) };
  const list = new BlockList();
  for (const part of v.split(",").map((p) => p.trim()).filter(Boolean)) {
    if (part.toLowerCase() === "loopback") {
      list.addSubnet("127.0.0.0", 8, "ipv4");
      list.addAddress("::1", "ipv6");
      continue;
    }
    const [address, mask] = part.split("/");
    const ip = normalizeIp(address);
    const family = isIP(ip);
    if (!family) {
      console.warn(`[net] TRUST_PROXY: "${part}" no es una IP/CIDR válida — se ignora.`);
      continue;
    }
    const type = family === 4 ? "ipv4" : "ipv6";
    if (mask !== undefined) list.addSubnet(ip, Number(mask), type);
    else list.addAddress(ip, type);
  }
  return { kind: "list", list };
}

function config(): Trust {
  // Se relee si cambió la env (tests) — en producción se parsea una sola vez.
  const current = process.env.TRUST_PROXY;
  if (cachedEnv === null || cachedEnv !== current) {
    cachedEnv = current;
    trust = parseTrust(current);
  }
  return trust;
}

function isTrusted(ip: string, list: BlockList): boolean {
  const family = isIP(ip);
  if (!family) return false;
  return list.check(ip, family === 4 ? "ipv4" : "ipv6");
}

function isLoopbackOrPrivate(ip: string): boolean {
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || ip === "::1";
}

/**
 * IP del cliente para rate limiting y auditoría. Nunca confía en `X-Forwarded-For` salvo
 * que `TRUST_PROXY` diga cuántos/cuáles proxies hay delante (ver cabecera).
 */
export function getClientIp(req: IncomingMessage): string {
  const socket = normalizeIp(req.socket?.remoteAddress ?? "") || "unknown";
  const rawXff = req.headers["x-forwarded-for"];
  const xff = (Array.isArray(rawXff) ? rawXff.join(",") : (rawXff ?? ""))
    .split(",")
    .map(normalizeIp)
    .filter(Boolean);

  const c = config();
  if (c.kind === "none") {
    if (!warned && xff.length && isLoopbackOrPrivate(socket)) {
      warned = true;
      console.warn(
        "[net] Llegan requests con X-Forwarded-For desde un proxy local pero TRUST_PROXY no está definido: " +
          "todos los clientes se ven con la IP del proxy y el rate limit de login es uno solo para todos. " +
          "Definí TRUST_PROXY=loopback (ver DEPLOY.md).",
      );
    }
    return socket;
  }

  // Cadena completa: lo que vino en el header + el socket (el salto más cercano).
  const chain = [...xff, socket];
  if (c.kind === "hops") {
    const i = chain.length - 1 - c.n;
    return chain[Math.max(0, i)];
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isTrusted(chain[i], c.list)) return chain[i];
  }
  return chain[0]; // todos los saltos son de confianza: el más lejano es el cliente
}
