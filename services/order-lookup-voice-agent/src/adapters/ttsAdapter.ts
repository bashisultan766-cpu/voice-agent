/**
 * TTS adapter — ElevenLabs primary, OpenAI tts-1-hd fallback.
 * Voice engine selection lives in voiceAdapter.ts (single entry point).
 */
import OpenAI from "openai";
import { getConfig, normalizeTwilioElevenLabsModel } from "../config.js";
import { logger } from "../utils/logger.js";
import { sanitizeTextForTTS } from "../utils/ttsFormatter.js";
import { pcm16leToMulaw8k } from "../utils/telephonyAudio.js";
import {
  ELEVENLABS_CIRCUIT_BREAKER_LOG,
  classifyElevenLabsHttpStatus,
  clearPreferredVoiceForCall,
  getMediaStreamTtsEngine,
  getGlobalVoiceProvider,
  getIsElevenLabsDisabled,
  getLockedElevenLabsVoiceId,
  getOpenAiEricFallbackVoice,
  getPreferredVoiceForCall,
  logVoiceEngineSelection,
  markElevenLabsAuthFailure,
  recordElevenLabsFailure,
  resetElevenLabsCircuitBreakerForTests,
  tripElevenLabsCircuitBreaker,
  type PreferredVoiceEngine,
} from "./voiceAdapter.js";

export {
  ELEVENLABS_CIRCUIT_BREAKER_LOG,
  classifyElevenLabsHttpStatus,
  clearPreferredVoiceForCall,
  getMediaStreamTtsEngine,
  getGlobalVoiceProvider,
  getIsElevenLabsDisabled,
  getLockedElevenLabsVoiceId,
  getOpenAiEricFallbackVoice,
  getPreferredVoiceForCall,
  markElevenLabsAuthFailure,
  recordElevenLabsFailure,
  resetElevenLabsCircuitBreakerForTests,
  tripElevenLabsCircuitBreaker,
  type PreferredVoiceEngine,
};

export const TTS_STREAM_CRASH_LOG = "TTS_STREAM_CRASH_DETECTED";
export const TTS_STREAM_FALLBACK_PREFIX =
  "I'm sorry, my audio disconnected. The number is";

export type TtsEngineName =
  | "ElevenLabs"
  | "OpenAI tts-1-hd"
  | "Media Streams (ElevenLabs)"
  | "Media Streams (OpenAI fallback)";

/** Telephony-native output formats only — never MP3 on the Twilio path. */
export type TelephonyAudioFormat = "ulaw_8000" | "pcm_16000";

/** ~20 ms of ulaw @ 8 kHz — lower bound for smooth stream playback. */
export const MIN_AUDIO_CHUNK_BYTES = 160;
/** ~50 ms of ulaw @ 8 kHz — upper bound to limit mouth-to-ear delay. */
export const MAX_AUDIO_CHUNK_BYTES = 400;

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

/** Log the active TTS engine — only at boot after static provider selection. */
export function logTtsEngineSelection(engine?: TtsEngineName): void {
  if (!getGlobalVoiceProvider()) return;
  logVoiceEngineSelection(engine as Parameters<typeof logVoiceEngineSelection>[0]);
}

function elevenLabsModelId(): string {
  const raw = getConfig().VOICE_MODEL.trim();
  const normalized = normalizeTwilioElevenLabsModel(raw);
  return normalized ? `eleven_${normalized}` : "eleven_turbo_v2_5";
}

/** Coerce to Twilio-native telephony format — MP3 causes double-encoding artifacts on phone lines. */
export function resolveTelephonyOutputFormat(): TelephonyAudioFormat {
  const format = getConfig().TTS_AUDIO_FORMAT;
  if (format === "mp3_44100_128") {
    logger.warn("tts_format_coerced", { from: format, to: "ulaw_8000" });
    return "ulaw_8000";
  }
  return format;
}

export function telephonyChunkBounds(format: TelephonyAudioFormat): {
  minBytes: number;
  maxBytes: number;
} {
  if (format === "pcm_16000") {
    return { minBytes: 640, maxBytes: 1600 };
  }
  return { minBytes: MIN_AUDIO_CHUNK_BYTES, maxBytes: MAX_AUDIO_CHUNK_BYTES };
}

function contentTypeForFormat(format: TelephonyAudioFormat): string {
  if (format === "ulaw_8000") return "audio/basic";
  return "audio/L16";
}

/**
 * Buffers variable-size ElevenLabs stream frames into 20–50 ms telephony chunks
 * before base64 / relay emission — prevents micro-stutter from tiny HTTP reads.
 */
export class AudioChunkAccumulator {
  private pending = Buffer.alloc(0);

  constructor(
    private readonly minBytes: number,
    private readonly maxBytes: number,
  ) {}

  ingest(chunk: Buffer): Buffer[] {
    if (!chunk.length) return [];
    this.pending = Buffer.concat([this.pending, chunk]);
    const ready: Buffer[] = [];

    while (this.pending.length >= this.maxBytes) {
      ready.push(this.pending.subarray(0, this.maxBytes));
      this.pending = this.pending.subarray(this.maxBytes);
    }

    while (this.pending.length >= this.minBytes && this.pending.length < this.maxBytes) {
      ready.push(this.pending);
      this.pending = Buffer.alloc(0);
      break;
    }

    return ready;
  }

  drain(): Buffer[] {
    if (!this.pending.length) return [];
    const tail = this.pending;
    this.pending = Buffer.alloc(0);
    return [tail];
  }
}

/** Re-chunk a complete buffer into telephony-aligned frames (20–50 ms). */
export function normalizeAudioChunks(buffer: Buffer, format?: TelephonyAudioFormat): Buffer {
  const { minBytes, maxBytes } = telephonyChunkBounds(format ?? resolveTelephonyOutputFormat());
  if (buffer.length <= minBytes) return buffer;

  const acc = new AudioChunkAccumulator(minBytes, maxBytes);
  const parts = acc.ingest(buffer).concat(acc.drain());
  return parts.length === 1 ? parts[0] : Buffer.concat(parts);
}

function stripSsmlForFallbackSpeech(text: string): string {
  return text
    .replace(/<break[^>]*\/?>/gi, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTtsFallbackSpeech(text: string): string {
  const spoken = stripSsmlForFallbackSpeech(text);
  return spoken ? `${TTS_STREAM_FALLBACK_PREFIX} ${spoken}` : TTS_STREAM_FALLBACK_PREFIX;
}

/** Yield OpenAI PCM as μ-law telephony frames for Twilio Media Streams. */
async function* yieldOpenAiTelephonyFrames(
  result: VoiceSynthesisResult,
  isFallback = false,
): AsyncGenerator<TtsStreamChunk, void, unknown> {
  const mulaw = pcm16leToMulaw8k(result.audio);
  const { minBytes, maxBytes } = telephonyChunkBounds("ulaw_8000");
  const accumulator = new AudioChunkAccumulator(minBytes, maxBytes);

  for (const frame of accumulator.ingest(mulaw).concat(accumulator.drain())) {
    yield { audio: frame, engine: result.engine, isFallback, sourceFormat: "ulaw_8000" };
  }
}

async function synthesizeViaElevenLabsStream(
  text: string,
  signal?: AbortSignal,
  _callSid?: string,
): Promise<Response | null> {
  if (getIsElevenLabsDisabled()) {
    return null;
  }
  const cfg = getConfig();
  const apiKey = cfg.ELEVENLABS_API_KEY;
  const voiceId = getLockedElevenLabsVoiceId();
  if (!apiKey || !voiceId) return null;

  const outputFormat = resolveTelephonyOutputFormat();

  const url = new URL(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
  );
  url.searchParams.set("output_format", outputFormat);

  return fetch(url.toString(), {
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
      optimize_streaming_latency: 2,
    }),
    signal,
  });
}

async function synthesizeViaElevenLabs(
  text: string,
  callSid?: string,
): Promise<VoiceSynthesisResult | null> {
  if (getIsElevenLabsDisabled()) {
    return null;
  }
  const cfg = getConfig();
  const apiKey = cfg.ELEVENLABS_API_KEY;
  const voiceId = getLockedElevenLabsVoiceId();
  if (!apiKey || !voiceId) return null;

  const outputFormat = resolveTelephonyOutputFormat();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await synthesizeViaElevenLabsStream(text, controller.signal, callSid);
    if (!res) return null;

    if (!res.ok) {
      recordElevenLabsFailure(classifyElevenLabsHttpStatus(res.status), {
        status: res.status,
        callSid,
      });
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    const raw = Buffer.from(arrayBuffer);
    return {
      audio: raw,
      contentType: res.headers.get("content-type") ?? contentTypeForFormat(outputFormat),
      engine: "ElevenLabs",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout =
      err instanceof Error &&
      (err.name === "AbortError" || /aborted|timeout/i.test(message));
    recordElevenLabsFailure(isTimeout ? "timeout" : "network_error", { callSid });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function synthesizeViaOpenAI(text: string): Promise<VoiceSynthesisResult | null> {
  const cfg = getConfig();
  if (!cfg.OPENAI_API_KEY) return null;

  try {
    const client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });
    const response = await client.audio.speech.create({
      model: "tts-1-hd",
      voice: getOpenAiEricFallbackVoice(),
      input: text,
      response_format: "pcm",
    });

    const arrayBuffer = await response.arrayBuffer();
    const raw = Buffer.from(arrayBuffer);
    return {
      audio: raw,
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
 * Primary live path streams μ-law over Twilio Media Streams (see streamHandler).
 */
export async function synthesizeSpeech(
  text: string,
  callSid?: string,
): Promise<VoiceSynthesisResult | null> {
  const trimmed = sanitizeTextForTTS(text);
  if (!trimmed) return null;

  try {
    if (getIsElevenLabsDisabled()) {
      return synthesizeViaOpenAI(trimmed);
    }

    const eleven = await synthesizeViaElevenLabs(trimmed, callSid);
    if (eleven) return eleven;

    return synthesizeViaOpenAI(trimmed);
  } catch (err) {
    logger.error(TTS_STREAM_CRASH_LOG, {
      error: err instanceof Error ? err.message : String(err),
      stage: "synthesizeSpeech",
    });
    return synthesizeViaOpenAI(buildTtsFallbackSpeech(trimmed));
  }
}

export interface TtsStreamChunk {
  audio: Buffer;
  engine: TtsEngineName;
  isFallback?: boolean;
  sourceFormat: TelephonyAudioFormat;
}

/**
 * Stream TTS audio with mid-stream error boundary — yields fallback speech on crash
 * so callers never hear dead silence after invalid SSML or connection drops.
 */
export async function* synthesizeSpeechStream(
  text: string,
  callSid?: string,
): AsyncGenerator<TtsStreamChunk, void, unknown> {
  const trimmed = sanitizeTextForTTS(text);
  if (!trimmed) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    if (getIsElevenLabsDisabled()) {
      const openAi = await synthesizeViaOpenAI(trimmed);
      if (openAi) {
        yield* yieldOpenAiTelephonyFrames(openAi);
      }
      return;
    }

    const res = await synthesizeViaElevenLabsStream(trimmed, controller.signal, callSid);
    if (!res?.ok || !res.body) {
      if (res) {
        recordElevenLabsFailure(classifyElevenLabsHttpStatus(res.status), {
          status: res.status,
          callSid,
        });
      } else {
        recordElevenLabsFailure("network_error", { callSid });
      }
      const fallback = await synthesizeViaOpenAI(buildTtsFallbackSpeech(trimmed));
      if (fallback) {
        yield* yieldOpenAiTelephonyFrames(fallback);
      }
      return;
    }

    const reader = res.body.getReader();
    const outputFormat = resolveTelephonyOutputFormat();
    const { minBytes, maxBytes } = telephonyChunkBounds(outputFormat);
    const accumulator = new AudioChunkAccumulator(minBytes, maxBytes);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) {
          for (const frame of accumulator.ingest(Buffer.from(value))) {
            yield {
              audio: frame,
              engine: "ElevenLabs",
              sourceFormat: outputFormat,
            };
          }
        }
      }
      for (const frame of accumulator.drain()) {
        yield {
          audio: frame,
          engine: "ElevenLabs",
          sourceFormat: outputFormat,
        };
      }
    } catch (streamErr) {
      logger.error(TTS_STREAM_CRASH_LOG, {
        error: streamErr instanceof Error ? streamErr.message : String(streamErr),
        stage: "elevenlabs_stream_read",
      });
      recordElevenLabsFailure("stream_crash", { callSid });
      const fallback = await synthesizeViaOpenAI(buildTtsFallbackSpeech(trimmed));
      if (fallback) {
        yield* yieldOpenAiTelephonyFrames(fallback, true);
      }
    } finally {
      reader.releaseLock();
    }
  } catch (err) {
    logger.error(TTS_STREAM_CRASH_LOG, {
      error: err instanceof Error ? err.message : String(err),
      stage: "elevenlabs_stream_open",
    });
    recordElevenLabsFailure("network_error", { callSid });
    const fallback = await synthesizeViaOpenAI(buildTtsFallbackSpeech(trimmed));
    if (fallback) {
      yield* yieldOpenAiTelephonyFrames(fallback, true);
    }
  } finally {
    clearTimeout(timer);
  }
}
