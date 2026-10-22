import http from "node:http";
import type { AddressInfo } from "node:net";
import type { HttpHandler } from "../../src/platform/net/http";

// ─────────────────────────────────────────────────────────────────────────────
// Cliente HTTP de prueba para la API del panel: un "navegador" con su propio frasco de
// cookies, el Origin del sitio en todo POST/PATCH (el CSRF del router lo exige) y su
// propia IP vía X-Forwarded-For (el test fija TRUST_PROXY=loopback): así el rate limit
// de un test no frena a otro.
// ─────────────────────────────────────────────────────────────────────────────

export interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startTestServer(handler: HttpHandler): Promise<TestServer> {
  const srv = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return {
    baseUrl,
    close: async () => {
      srv.closeAllConnections();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    },
  };
}

export interface ApiResponse<T = any> {
  status: number;
  /** Cuerpo JSON (null si vino vacío, p. ej. 204). */
  body: T;
  headers: Headers;
  /** Cabeceras Set-Cookie crudas de esta respuesta. */
  setCookies: string[];
}

let nextIp = 1;

export class Browser {
  readonly cookies = new Map<string, string>();
  readonly ip: string;

  constructor(
    private readonly baseUrl: string,
    ip?: string,
  ) {
    this.ip = ip ?? `198.51.100.${nextIp++}`;
  }

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const h: Record<string, string> = { "x-forwarded-for": this.ip, ...headers };
    if (method !== "GET") h.origin = this.baseUrl;
    if (body !== undefined) h["content-type"] = "application/json";
    if (this.cookies.size > 0) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${this.baseUrl}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookies = res.headers.getSetCookie();
    for (const raw of setCookies) {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (/max-age=0(?!\d)/i.test(raw) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers, setCookies };
  }

  get<T = any>(path: string, headers?: Record<string, string>) {
    return this.request<T>("GET", path, undefined, headers);
  }

  post<T = any>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>("POST", path, body, headers);
  }

  patch<T = any>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>("PATCH", path, body, headers);
  }

  put<T = any>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>("PUT", path, body, headers);
  }

  delete<T = any>(path: string, headers?: Record<string, string>) {
    return this.request<T>("DELETE", path, undefined, headers);
  }

  /** GET de algo que no es JSON (p. ej. una descarga CSV): el cuerpo como texto, sin parsear (con el BOM si viene). */
  async getText(path: string): Promise<{ status: number; text: string; headers: Headers }> {
    const h: Record<string, string> = { "x-forwarded-for": this.ip };
    if (this.cookies.size > 0) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${this.baseUrl}${path}`, { headers: h });
    // `ignoreBOM`: el BOM de UTF-8 queda en el texto (los tests de exportación lo verifican).
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
    return { status: res.status, text, headers: res.headers };
  }

  /** Otro navegador con las mismas cookies (otro dispositivo con la misma sesión). */
  clone(): Browser {
    const other = new Browser(this.baseUrl, this.ip);
    for (const [k, v] of this.cookies) other.cookies.set(k, v);
    return other;
  }
}
