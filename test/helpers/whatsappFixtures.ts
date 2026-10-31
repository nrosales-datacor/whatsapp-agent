import { createHmac } from "node:crypto";
import type { AgentRunner, AgentTurnInput, AgentTurnResult } from "../../src/modules/whatsapp/agentContract";
import { createWhatsAppDeps, type WhatsAppDeps } from "../../src/modules/whatsapp/deps";
import type { ChannelCredentials, ReplyButton, TemplateMessage, WhatsAppApi, MetaSignupApi } from "../../src/modules/whatsapp/graph";
import type { MediaStorage } from "../../src/modules/whatsapp/media";
import type { PushTarget } from "../../src/modules/whatsapp/push";
import { whatsappChannels } from "../../src/modules/whatsapp/schema";
import { encrypt } from "../../src/platform/crypto/secrets";
import { withTenant, type Db } from "../../src/platform/db/scope";

// ─────────────────────────────────────────────────────────────────────────────
// Dobles y datos para los tests del módulo WhatsApp. Graph, OpenAI, Storage y Web Push
// nunca salen a la red: cada doble anota lo que se le pidió.
//
// IMPORTANTE: importar este archivo DESPUÉS de fijar TOKENS_ENCRYPTION_KEY (lo usa
// src/platform/crypto/secrets.ts al cargarse).
// ─────────────────────────────────────────────────────────────────────────────

export const APP_SECRET = "test-app-secret";
export const VERIFY_TOKEN = "test-verify-token";

export interface SentMessage {
  kind: "text" | "buttons" | "template";
  phoneNumberId: string;
  to: string;
  text?: string;
  buttons?: ReplyButton[];
  template?: TemplateMessage;
}

export interface FakeWhatsApp {
  deps: WhatsAppDeps;
  sent: SentMessage[];
  agentCalls: AgentTurnInput[];
  pushes: { target: PushTarget; payload: { title: string; body: string; url?: string } }[];
  uploads: { path: string; contentType: string }[];
  /** Respuesta del agente (o función por turno). */
  agentResult: AgentTurnResult | ((input: AgentTurnInput) => AgentTurnResult | Promise<AgentTurnResult>);
  /** Si está, el próximo envío falla con este error (y se borra). */
  failNextSend: Error | null;
  transcript: string;
}

const okResult = (text: string): AgentTurnResult => ({ replies: [{ text }], actions: [], usage: { inputTokens: 100, outputTokens: 20, costMicros: 50 } });

export function fakeWhatsApp(db: Db, overrides: Partial<WhatsAppDeps> = {}): FakeWhatsApp {
  const fake: FakeWhatsApp = {
    deps: undefined as unknown as WhatsAppDeps,
    sent: [],
    agentCalls: [],
    pushes: [],
    uploads: [],
    agentResult: okResult("¡Hola! ¿En qué te ayudo?"),
    failNextSend: null,
    transcript: "Quiero una cita para mañana",
  };
  const send = async (msg: SentMessage) => {
    if (fake.failNextSend) {
      const e = fake.failNextSend;
      fake.failNextSend = null;
      throw e;
    }
    fake.sent.push(msg);
    return { messageId: `wamid.out.${fake.sent.length}` };
  };
  const api: WhatsAppApi & MetaSignupApi = {
    sendText: (ch: ChannelCredentials, to, text) => send({ kind: "text", phoneNumberId: ch.phoneNumberId, to, text }),
    sendButtons: (ch, to, body, buttons) => send({ kind: "buttons", phoneNumberId: ch.phoneNumberId, to, text: body, buttons }),
    sendTemplate: (ch, to, template) => send({ kind: "template", phoneNumberId: ch.phoneNumberId, to, template }),
    downloadMedia: async () => ({ buffer: Buffer.from("bytes-del-adjunto"), mimeType: "image/jpeg" }),
    getPhoneNumber: async (ch) => ({ id: ch.phoneNumberId, displayPhone: "+506 8888 0000", verifiedName: "Negocio" }),
    exchangeCode: async (code) => {
      if (code === "bad") throw new Error("código vencido");
      return "token-del-waba-de-prueba-123456";
    },
    listWhatsAppAccounts: async () => ["1234567890"],
    listPhoneNumbers: async () => [{ id: "5550001111", displayPhone: "+506 2222 3333", verifiedName: "Negocio" }],
    subscribeApp: async () => true,
    registerNumber: async () => true,
  };
  const storage: MediaStorage = {
    configured: () => true,
    upload: async (path, _body, contentType) => {
      fake.uploads.push({ path, contentType });
      return path;
    },
    signedUrl: async (path) => (path ? `https://storage.test/${path}?token=x` : undefined),
    remove: async (paths) => paths.length,
  };
  const agent: AgentRunner = async (_executor, input) => {
    fake.agentCalls.push(input);
    return typeof fake.agentResult === "function" ? fake.agentResult(input) : fake.agentResult;
  };
  fake.deps = createWhatsAppDeps(db, {
    api,
    storage,
    agent,
    transcribe: async () => ({ text: fake.transcript, durationSec: 30 }),
    push: () => async (target, payload) => {
      fake.pushes.push({ target, payload: JSON.parse(payload) });
    },
    getAiLimits: () => ({ monthlyConversations: null, monthlySpendMicros: null }),
    ...overrides,
  });
  return fake;
}

/** Canal conectado (con token) del negocio. */
export async function createChannel(
  db: Db,
  businessId: string,
  options: { phoneNumberId?: string; locationId?: string | null; templates?: Record<string, { name: string; language: string }>; token?: string | null } = {},
): Promise<{ channelId: string; phoneNumberId: string }> {
  const phoneNumberId = options.phoneNumberId ?? String(Math.floor(1e11 + Math.random() * 9e11));
  const token = options.token === undefined ? "token-de-prueba-del-negocio" : options.token;
  const [row] = await withTenant(db, businessId, (tx) =>
    tx
      .insert(whatsappChannels)
      .values({
        businessId,
        phoneNumberId,
        locationId: options.locationId ?? null,
        accessTokenEncrypted: token ? encrypt(token) : null,
        templates: options.templates ?? {},
        status: token ? "active" : "pending",
      })
      .returning({ id: whatsappChannels.id }),
  );
  return { channelId: row.id, phoneNumberId };
}

let seq = 0;

/** Payload de Meta con UN mensaje entrante. */
export function inboundBody(input: {
  phoneNumberId: string;
  from: string;
  id?: string;
  name?: string;
  text?: string;
  type?: string;
  message?: Record<string, unknown>;
}): Record<string, unknown> {
  const id = input.id ?? `wamid.test.${Date.now()}.${++seq}`;
  const type = input.type ?? "text";
  const message = input.message ?? (type === "text" ? { text: { body: input.text ?? "hola" } } : {});
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "50622223333", phone_number_id: input.phoneNumberId },
              contacts: [{ profile: { name: input.name ?? "Cliente WhatsApp" }, wa_id: input.from }],
              messages: [{ from: input.from, id, timestamp: String(Math.floor(Date.now() / 1000)), type, ...message }],
            },
          },
        ],
      },
    ],
  };
}

/** Payload de un estado (entregado/leído): se ignora. */
export function statusBody(phoneNumberId: string): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, statuses: [{ id: "wamid.x", status: "read" }] } }] }],
  };
}

export function sign(raw: string, secret = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

export { okResult };

/** Página Ogg mínima (sin CRC: el lector de duración no lo valida). */
function oggPage(headerType: number, granule: bigint, sequence: number, packet: Buffer): Buffer {
  const header = Buffer.alloc(27);
  header.write("OggS", 0, "latin1");
  header[4] = 0;
  header[5] = headerType;
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(1, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = 1;
  return Buffer.concat([header, Buffer.from([packet.length]), packet]);
}

/** Nota de voz Ogg/Opus de `seconds` segundos (solo contenedor: encabezado y una página final). */
export function oggOpusAudio(seconds: number, preSkip = 312): Buffer {
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "latin1");
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(48_000, 12);
  const tags = Buffer.from("OpusTags\0\0\0\0\0\0\0\0", "latin1");
  return Buffer.concat([
    oggPage(2, 0n, 0, head),
    oggPage(0, 0n, 1, tags),
    oggPage(4, BigInt(Math.round(seconds * 48_000) + preSkip), 2, Buffer.from("audio-de-mentira")),
  ]);
}
