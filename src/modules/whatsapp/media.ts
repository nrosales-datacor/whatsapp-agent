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
