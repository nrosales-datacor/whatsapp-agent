import OpenAI from "openai";
import type { Tenant } from "../types";
import { descargarMedia } from "./client";
import { OPENAI_MAX_REINTENTOS, TIMEOUT_OPENAI_AUDIO_MS } from "../red/timeouts";

// Inicialización PEREZOSA, igual que en runAgent.ts: el `new OpenAI()` a nivel de
// módulo tiraba TODO el proceso al arrancar si faltaba OPENAI_API_KEY (el SDK lanza en
// el constructor), aunque el resto del bot —panel, webhook, agenda— no la necesite.
// Timeout explícito (ver src/red/timeouts.ts): sin él, un audio que Whisper no procesa
// cuelga el worker serial hasta 30 min y con él la cola de todos los tenants.
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    _openai = new OpenAI({ timeout: TIMEOUT_OPENAI_AUDIO_MS, maxRetries: OPENAI_MAX_REINTENTOS });
  }
  return _openai;
}

// WhatsApp envía notas de voz en audio/ogg (opus). Whisper también acepta mp3,
// mp4, m4a, wav, webm. Mapeamos el mime_type a la extensión correcta para que
// la API no rechace el archivo por nombre sin extensión.
function extDeAudio(mimeType: string): string {
  const mapa: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "mp4",
    "audio/mp4a-latm": "mp4",
    "audio/aac": "mp4",
    "audio/webm": "webm",
    "audio/wav": "wav",
  };
  const base = mimeType.split(";")[0].trim();
  return mapa[base] ?? "ogg";
}

/**
 * Descarga el audio de WhatsApp y lo transcribe con Whisper.
 * Devuelve el texto transcrito, o lanza si hay error de red/API.
 */
export async function transcribirAudio(tenant: Tenant, mediaId: string): Promise<string> {
  const { buffer, mimeType } = await descargarMedia(tenant, mediaId);
  const ext = extDeAudio(mimeType);
  const archivo = new File([new Uint8Array(buffer)], `audio.${ext}`, { type: mimeType.split(";")[0] });
  const resultado = await getOpenAI().audio.transcriptions.create({
    file: archivo,
    model: "whisper-1",
    language: "es",
  });
  return resultado.text.trim();
}
