import { getConfig, conversationRelayVoice } from "../config.js";
import { logger } from "../utils/logger.js";
import { getCachedPhrase } from "../utils/phraseCache.js";
import type { SpeechChunk } from "../types/order.js";

export interface VoiceSynthesisResult {
  audio: Buffer;
  contentType: string;
}

const ELEVENLABS_VOICE_SETTINGS = {
  stability: 0.42,
  similarity_boost: 0.78,
  style: 0.22,
  use_speaker_boost: true,
};

/**
 * Direct ElevenLabs TTS — one sentence per request for lowest latency.
 * Primary live path uses Twilio ConversationRelay text tokens.
 */
export async function synthesizeSpeechChunk(text: string): Promise<VoiceSynthesisResult | null> {
  const apiKey = getConfig().ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  const cached = chunkAudioCache.get(text);
  if (cached) return cached;

  const voiceId = (getConfig().VOICE_ID || getConfig().ELEVENLABS_VOICE_ID || "").trim();
  if (!voiceId) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: applyVoiceProsody(text),
          model_id: "eleven_turbo_v2_5",
          voice_settings: ELEVENLABS_VOICE_SETTINGS,
        }),
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      const body = await res.text();
      logger.warn("elevenlabs_chunk_tts_failed", { status: res.status, body: body.slice(0, 80) });
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    const result: VoiceSynthesisResult = {
      audio: Buffer.from(arrayBuffer),
      contentType: res.headers.get("content-type") ?? "audio/mpeg",
    };
    if (isCacheablePhrase(text)) {
      chunkAudioCache.set(text, result);
    }
    return result;
  } catch (err) {
    logger.warn("elevenlabs_chunk_tts_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const chunkAudioCache = new Map<string, VoiceSynthesisResult>();

function isCacheablePhrase(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return [
    getCachedPhrase("checking").toLowerCase(),
    getCachedPhrase("found_order").toLowerCase(),
    getCachedPhrase("closing_question").toLowerCase(),
  ].includes(normalized);
}

/** Light prosody hints — ConversationRelay passes plain text to ElevenLabs. */
export function applyVoiceProsody(text: string): string {
  return text
    .replace(/\s*—\s*/g, "... ")
    .replace(/\.\.\./g, "... ")
    .trim();
}

export { getCachedPhrase } from "../utils/phraseCache.js";

export function buildConversationRelayVoiceAttrs(): Record<string, string> {
  const cfg = getConfig();
  const attrs: Record<string, string> = {
    language: cfg.VOICE_LANGUAGE,
    interruptible: "true",
    dtmfDetection: "true",
  };

  if (cfg.VOICE_TTS_PROVIDER.toLowerCase() === "elevenlabs") {
    attrs.ttsProvider = "ElevenLabs";
    attrs.voice = conversationRelayVoice();
    attrs.elevenlabsTextNormalization = cfg.ELEVENLABS_TEXT_NORMALIZATION;
  } else {
    attrs.voice = conversationRelayVoice();
  }

  return attrs;
}

export interface StreamRelayOptions {
  abortSignal?: AbortSignal;
}

export async function streamOneChunkToRelay(
  chunk: SpeechChunk,
  send: (msg: {
    type: "text";
    token: string;
    last: boolean;
    interruptible?: boolean;
  }) => Promise<void>,
  isLast: boolean,
  options?: StreamRelayOptions,
): Promise<void> {
  if (options?.abortSignal?.aborted) return;

  if (chunk.pauseMs && chunk.pauseMs > 0) {
    await sleep(Math.min(chunk.pauseMs, getConfig().VOICE_CHUNK_MAX_PAUSE_MS), options?.abortSignal);
  }

  if (options?.abortSignal?.aborted) return;

  await send({
    type: "text",
    token: applyVoiceProsody(chunk.text),
    last: isLast,
    interruptible: chunk.kind !== "payment",
  });
}

export async function finalizeRelayStream(
  send: (msg: { type: "text"; token: string; last: boolean }) => Promise<void>,
): Promise<void> {
  await send({ type: "text", token: "", last: true });
}

/**
 * Stream speech chunks to Twilio ConversationRelay immediately — no full-response buffering.
 */
export async function streamChunksToRelay(
  chunks: AsyncIterable<SpeechChunk>,
  send: (msg: {
    type: "text";
    token: string;
    last: boolean;
    interruptible?: boolean;
  }) => Promise<void>,
  options?: StreamRelayOptions,
): Promise<number> {
  let count = 0;
  const pending: SpeechChunk[] = [];

  for await (const chunk of chunks) {
    if (options?.abortSignal?.aborted) break;
    pending.push(chunk);
    await streamOneChunkToRelay(chunk, send, false, options);
    count++;
  }

  if (!options?.abortSignal?.aborted && count > 0) {
    await finalizeRelayStream(send);
  }

  return count;
}

/** @deprecated Use streamChunksToRelay for streaming turns. */
export async function streamTextToRelay(
  text: string,
  send: (msg: { type: "text"; token: string; last: boolean; interruptible?: boolean }) => Promise<void>,
): Promise<void> {
  const sentences = splitForTts(text);
  for (let i = 0; i < sentences.length; i++) {
    await send({
      type: "text",
      token: applyVoiceProsody(sentences[i]),
      last: i === sentences.length - 1,
      interruptible: true,
    });
  }
}

function splitForTts(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [text.trim()];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function prewarmVoiceCache(): Promise<void> {
  const phrases = [
    getCachedPhrase("checking"),
    getCachedPhrase("found_order"),
    getCachedPhrase("closing_question"),
  ];
  await Promise.all(phrases.map((p) => synthesizeSpeechChunk(p)));
}
