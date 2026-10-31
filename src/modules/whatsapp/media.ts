import OpenAI from "openai";
import { msFromEnv } from "../../platform/net/timeouts";
import { cachedSignedUrl, deleteObjects, objectPath, storageConfigured, uploadObject } from "../../platform/storage/supabaseStorage";

// ─────────────────────────────────────────────────────────────────────────────
// Adjuntos del cliente: fotos y notas de voz van a Supabase Storage (bucket privado, en la
// base solo queda la ruta y la bandeja muestra una URL firmada de corta vida), y las notas
// de voz se transcriben con Whisper para que el agente las entienda. Las dos piezas son
// inyectables: los tests nunca salen a la red.
// ─────────────────────────────────────────────────────────────────────────────

export interface MediaStorage {
  configured(): boolean;
  /** Sube el adjunto y devuelve su ruta. Lanza si falla. */
  upload(path: string, body: Buffer, contentType: string): Promise<string>;
  /** URL firmada (cacheada) para mostrar; undefined si no se pudo firmar. */
  signedUrl(path: string | null | undefined): Promise<string | undefined>;
  /** Borra adjuntos por ruta (derecho de supresión). Lanza si falla. */
  remove(paths: string[]): Promise<number>;
}

/** Storage real (src/platform/storage). */
export const supabaseMediaStorage: MediaStorage = {
  configured: storageConfigured,
  upload: uploadObject,
  signedUrl: cachedSignedUrl,
  remove: deleteObjects,
};

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/webm": "webm",
  "audio/wav": "wav",
  "application/pdf": "pdf",
};

/** Tipo MIME sin parámetros ("audio/ogg; codecs=opus" → "audio/ogg"). */
export function baseMime(mimeType: string): string {
  return mimeType.split(";")[0].trim().toLowerCase();
}

/** Ruta del adjunto de un mensaje: `{negocio}/whatsapp/{conversación}/{wamid}.{ext}` (idempotente). */
export function mediaObjectPath(businessId: string, conversationId: string, waMessageId: string, mimeType: string): string {
  const ext = EXTENSIONS[baseMime(mimeType)] ?? "bin";
  return objectPath(businessId, "whatsapp", conversationId, `${waMessageId}.${ext}`);
}

// ── Transcripción ────────────────────────────────────────────────────────────

export interface Transcription {
  text: string;
  /** Duración del audio en segundos (Whisper cobra por minuto). */
  durationSec: number;
}

export type AudioTranscriber = (audio: Buffer, mimeType: string) => Promise<Transcription>;

// ── Topes de audio ───────────────────────────────────────────────────────────
//
// Una nota de voz demasiado larga no se transcribe ni va al agente: el cliente recibe el
// texto fijo `audioTooLong` y el equipo, un aviso. Tres barreras, de la más barata a la
// más cara:
//   1. Bytes, en la descarga (`WHATSAPP_AUDIO_MAX_BYTES`, ./graph.ts): ni se baja.
//   2. Duración leída del contenedor Ogg (opus/vorbis: así manda WhatsApp las notas de voz)
//      ANTES de Whisper (`audioDurationSec`): no se paga la transcripción.
//   3. Duración que devuelve Whisper (otros formatos): ya se pagó, pero no va al agente.
// La transcripción que se guarda (y que lee el agente) se corta a `MAX_TRANSCRIPT_CHARS`.

/** Duración máxima de una nota de voz que se transcribe (`AGENT_AUDIO_MAX_SEC`, 10-1800, default 120 = 2 min). */
export function audioMaxSec(): number {
  const raw = process.env.AGENT_AUDIO_MAX_SEC;
  const n = raw !== undefined && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 10 && n <= 1800 ? n : 120;
}

/** Largo máximo de la transcripción guardada (como un texto entrante, ver payload.ts). */
export const MAX_TRANSCRIPT_CHARS = 4096;

/** Corta la transcripción a `MAX_TRANSCRIPT_CHARS` (por caracteres, sin partir un emoji). */
export function clipTranscript(text: string): string {
  const chars = Array.from(text.trim());
  return chars.length <= MAX_TRANSCRIPT_CHARS ? chars.join("") : `${chars.slice(0, MAX_TRANSCRIPT_CHARS - 1).join("")}…`;
}

const OGG_CAPTURE = Buffer.from("OggS");
const OGG_HEADER_BYTES = 27;

/**
 * Duración en segundos de un audio Ogg (Opus o Vorbis) leída del contenedor, sin decodificar:
 * la posición de granulado de la última página (muestras a 48 kHz en Opus, menos el
 * pre-skip; a la tasa del encabezado en Vorbis). null si no es Ogg o no se puede leer (la
 * barrera de Whisper queda de respaldo).
 */
export function audioDurationSec(audio: Buffer, mimeType: string): number | null {
  const mime = baseMime(mimeType);
  if (mime && mime !== "audio/ogg" && mime !== "audio/opus" && mime !== "application/ogg") return null;
  if (audio.length < OGG_HEADER_BYTES + 1 || !audio.subarray(0, 4).equals(OGG_CAPTURE)) return null;
  const firstPacket = OGG_HEADER_BYTES + audio[26];
  let rate: number;
  let preSkip = 0;
  if (audio.toString("latin1", firstPacket, firstPacket + 8) === "OpusHead" && audio.length >= firstPacket + 12) {
    rate = 48_000;
    preSkip = audio.readUInt16LE(firstPacket + 10);
  } else if (audio.toString("latin1", firstPacket, firstPacket + 7) === "\x01vorbis" && audio.length >= firstPacket + 16) {
    rate = audio.readUInt32LE(firstPacket + 12);
  } else {
    return null;
  }
  if (!(rate > 0)) return null;
  // Última página con granulado válido (-1 = ningún paquete termina en esa página).
  for (let at = audio.lastIndexOf(OGG_CAPTURE); at > 0; at = audio.lastIndexOf(OGG_CAPTURE, at - 1)) {
    if (at + OGG_HEADER_BYTES > audio.length || audio[at + 4] !== 0) continue;
    const granule = audio.readBigInt64LE(at + 6);
    if (granule < 0n) continue;
    return Math.max(0, Number(granule) - preSkip) / rate;
  }
  return null;
}

const OPENAI_AUDIO_TIMEOUT_MS = msFromEnv("OPENAI_AUDIO_TIMEOUT_MS", 60_000);
let openai: OpenAI | null = null;

/**
 * Whisper (whisper-1) sin idioma fijo: lo autodetecta, así una nota de voz en inglés no
 * sale "traducida". Cliente perezoso: sin OPENAI_API_KEY el SDK lanza al construirse, y eso
 * no debe tumbar el proceso (solo esta transcripción, que cae al aviso "no pude escucharla").
 * `verbose_json` es el único formato que trae la duración, que es lo que se cobra.
 */
export const whisperTranscriber: AudioTranscriber = async (audio, mimeType) => {
  openai ??= new OpenAI({ timeout: OPENAI_AUDIO_TIMEOUT_MS, maxRetries: 1 });
  const mime = baseMime(mimeType) || "audio/ogg";
  const ext = EXTENSIONS[mime] ?? "ogg";
  const file = new File([new Uint8Array(audio)], `audio.${ext}`, { type: mime });
  const result = await openai.audio.transcriptions.create({ file, model: "whisper-1", response_format: "verbose_json" });
  return { text: (result.text ?? "").trim(), durationSec: Number(result.duration ?? 0) };
};
