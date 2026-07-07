import { getConfig, conversationRelayVoice } from "../config.js";
import {
  getIsElevenLabsDisabled,
  synthesizeSpeech,
  type VoiceSynthesisResult,
} from "../adapters/ttsAdapter.js";
import { smoothForVoice } from "./voiceSmoothingEngine.js";
import { isTrackingDictationText, sanitizeTextForTTS } from "../utils/ttsFormatter.js";
import { getCachedPhrase } from "../utils/phraseCache.js";
import type { SpeechChunk } from "../types/order.js";

export type { VoiceSynthesisResult };

const chunkAudioCache = new Map<string, VoiceSynthesisResult>();

/**
 * Direct TTS synthesis — one sentence per request for cache prewarm.
 * Primary live path uses Twilio ConversationRelay text tokens.
 */
export async function synthesizeSpeechChunk(text: string): Promise<VoiceSynthesisResult | null> {
  const cached = chunkAudioCache.get(text);
  if (cached) return cached;

  const result = await synthesizeSpeech(text);
  if (result && isCacheablePhrase(text)) {
    chunkAudioCache.set(text, result);
  }
  return result;
}

function isCacheablePhrase(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return [
    getCachedPhrase("found_order").toLowerCase(),
    getCachedPhrase("closing_question").toLowerCase(),
    getCachedPhrase("follow_up").toLowerCase(),
    getCachedPhrase("goodbye").toLowerCase(),
  ].includes(normalized);
}

/** Light prosody + rhythm smoothing for ConversationRelay text tokens. */
export function applyVoiceProsody(text: string, preserveFull = false): string {
  const trimmed = text
    .replace(/\s*—\s*/g, "... ")
    .replace(/\.\.\./g, "... ")
    .trim();

  if (isTrackingDictationText(trimmed) || /<break\s+time=/i.test(trimmed)) {
    return sanitizeTextForTTS(trimmed);
  }

  return smoothForVoice(trimmed, { preserveFull });
}

export { getCachedPhrase } from "../utils/phraseCache.js";

export function buildConversationRelayVoiceAttrs(): Record<string, string> {
  const cfg = getConfig();
  const attrs: Record<string, string> = {
    language: cfg.VOICE_LANGUAGE,
    interruptible: "true",
    dtmfDetection: "true",
  };

  const useElevenLabs =
    !getIsElevenLabsDisabled() && cfg.VOICE_TTS_PROVIDER.toLowerCase() === "elevenlabs";

  if (useElevenLabs) {
    attrs.ttsProvider = "ElevenLabs";
    attrs.voice = conversationRelayVoice();
    attrs.elevenlabsTextNormalization = cfg.ELEVENLABS_TEXT_NORMALIZATION;
  } else {
    attrs.voice = getIsElevenLabsDisabled()
      ? "Google.en-US-Neural2-J"
      : conversationRelayVoice();
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

  const token = applyVoiceProsody(chunk.text, chunk.preserveFull === true);

  await send({
    type: "text",
    token,
    last: isLast,
    interruptible: chunk.kind !== "payment" && chunk.kind !== "dictation",
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
    getCachedPhrase("found_order"),
    getCachedPhrase("closing_question"),
    getCachedPhrase("follow_up"),
    getCachedPhrase("goodbye"),
  ];
  await Promise.all(phrases.map((p) => synthesizeSpeechChunk(p)));
}
