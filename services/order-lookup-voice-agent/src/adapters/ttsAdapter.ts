/**
 * TTS adapter — ElevenLabs primary, OpenAI tts-1-hd fallback.
 * Enforces Twilio-native audio format and logs the active engine before every synthesis.
 */
import OpenAI from "openai";
import { getConfig, normalizeTwilioElevenLabsModel } from "../config.js";
import { logger } from "../utils/logger.js";

export type TtsEngineName =
  | "ElevenLabs"
  | "OpenAI tts-1-hd"
  | "Twilio ConversationRelay (ElevenLabs)"
  | "Twilio ConversationRelay (Google fallback)";

/** Minimum mulaw/pcm chunk size — ~40 ms at 8 kHz; avoids micro-stutter on stream playback. */
export const MIN_AUDIO_CHUNK_BYTES = 320;

export interface VoiceSynthesisResult {
  audio: Buffer;
  contentType: string;
  engine: TtsEngineName;
}

export interface ElevenLabsVoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
}

/** Studio-quality voice settings sourced from config (never hardcoded). */
export function getElevenLabsVoiceSettings(): ElevenLabsVoiceSettings {
  const cfg = getConfig();
  return {
    stability: cfg.VOICE_STABILITY,
    similarity_boost: cfg.VOICE_SIMILARITY,
    style: cfg.VOICE_STYLE,
    use_speaker_boost: true,
  };
}

/** Resolve which engine handles live ConversationRelay TTS (Twilio-side synthesis). */
export function getConversationRelayTtsEngine(): TtsEngineName {
  const cfg = getConfig();
  const voiceId = (cfg.VOICE_ID || cfg.ELEVENLABS_VOICE_ID || "").trim();
  if (cfg.VOICE_TTS_PROVIDER.toLowerCase() === "elevenlabs" && voiceId) {
    return "Twilio ConversationRelay (ElevenLabs)";
  }
  return "Twilio ConversationRelay (Google fallback)";
}

/** Log the active TTS engine — call at turn start and before direct audio synthesis. */
export function logTtsEngineSelection(engine?: TtsEngineName): void {
  const name = engine ?? getConversationRelayTtsEngine();
  logger.info(`Generating TTS via: ${name}`);
}

function elevenLabsModelId(): string {
  const raw = getConfig().VOICE_MODEL.trim();
  const normalized = normalizeTwilioElevenLabsModel(raw);
  return normalized ? `eleven_${normalized}` : "eleven_turbo_v2_5";
}

function contentTypeForFormat(format: string): string {
  if (format === "ulaw_8000") return "audio/basic";
  if (format.startsWith("pcm")) return "audio/L16";
  return "audio/mpeg";
}

/** Re-chunk raw audio so no frame is smaller than MIN_AUDIO_CHUNK_BYTES (except the tail). */
export function normalizeAudioChunks(buffer: Buffer): Buffer {
  if (buffer.length <= MIN_AUDIO_CHUNK_BYTES) return buffer;

  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    if (remaining <= MIN_AUDIO_CHUNK_BYTES * 1.5) {
      chunks.push(buffer.subarray(offset));
      break;
    }
    chunks.push(buffer.subarray(offset, offset + MIN_AUDIO_CHUNK_BYTES));
    offset += MIN_AUDIO_CHUNK_BYTES;
  }

  return Buffer.concat(chunks);
}

async function synthesizeViaElevenLabs(text: string): Promise<VoiceSynthesisResult | null> {
  const cfg = getConfig();
  const apiKey = cfg.ELEVENLABS_API_KEY;
  const voiceId = (cfg.VOICE_ID || cfg.ELEVENLABS_VOICE_ID || "").trim();
  if (!apiKey || !voiceId) return null;

  const outputFormat = cfg.TTS_AUDIO_FORMAT;
  logTtsEngineSelection("ElevenLabs");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const url = new URL(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
    );
    url.searchParams.set("output_format", outputFormat);

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: contentTypeForFormat(outputFormat),
      },
      body: JSON.stringify({
        text,
        model_id: elevenLabsModelId(),
        voice_settings: getElevenLabsVoiceSettings(),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      logger.warn("elevenlabs_tts_failed", { status: res.status, body: body.slice(0, 80) });
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    const raw = Buffer.from(arrayBuffer);
    return {
      audio: normalizeAudioChunks(raw),
      contentType: res.headers.get("content-type") ?? contentTypeForFormat(outputFormat),
      engine: "ElevenLabs",
    };
  } catch (err) {
    logger.warn("elevenlabs_tts_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function synthesizeViaOpenAI(text: string): Promise<VoiceSynthesisResult | null> {
  const cfg = getConfig();
  if (!cfg.OPENAI_API_KEY) return null;

  logTtsEngineSelection("OpenAI tts-1-hd");

  try {
    const client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });
    const response = await client.audio.speech.create({
      model: "tts-1-hd",
      voice: "nova",
      input: text,
      response_format: "pcm",
    });

    const arrayBuffer = await response.arrayBuffer();
    const raw = Buffer.from(arrayBuffer);
    return {
      audio: normalizeAudioChunks(raw),
      contentType: "audio/L16",
      engine: "OpenAI tts-1-hd",
    };
  } catch (err) {
    logger.warn("openai_tts_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Synthesize speech for cache prewarm / offline playback.
 * Primary live path is Twilio ConversationRelay text tokens (see streamHandler).
 */
export async function synthesizeSpeech(text: string): Promise<VoiceSynthesisResult | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const eleven = await synthesizeViaElevenLabs(trimmed);
  if (eleven) return eleven;

  logger.warn("tts_fallback", { from: "ElevenLabs", to: "OpenAI tts-1-hd" });
  return synthesizeViaOpenAI(trimmed);
}
