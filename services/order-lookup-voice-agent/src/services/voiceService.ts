/**
 * Voice output layer — ElevenLabs direct API only. Twilio never generates speech.
 */
import { getCachedPhrase } from "../utils/phraseCache.js";
import { saveAudio } from "../audio/audioManager.js";
import { prepareSpeechText, synthesizeSpeech } from "../voice/tts/elevenlabs.js";
import type { SpeechChunk } from "../types/order.js";

export interface VoiceSynthesisResult {
  audio: Buffer;
  contentType: string;
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

/** Synthesize one sentence via direct ElevenLabs API. */
export async function synthesizeSpeechChunk(text: string): Promise<VoiceSynthesisResult | null> {
  const cached = chunkAudioCache.get(text);
  if (cached) return cached;

  try {
    const result = await synthesizeSpeech(text);
    if (isCacheablePhrase(text)) {
      chunkAudioCache.set(text, result);
    }
    return result;
  } catch {
    return null;
  }
}

export function applyVoiceProsody(text: string): string {
  return prepareSpeechText(text);
}

export { getCachedPhrase } from "../utils/phraseCache.js";

export async function prewarmVoiceCache(): Promise<void> {
  const phrases = [
    getCachedPhrase("checking"),
    getCachedPhrase("found_order"),
    getCachedPhrase("closing_question"),
  ];
  await Promise.all(
    phrases.map(async (phrase) => {
      const result = await synthesizeSpeechChunk(phrase);
      if (result) {
        await saveAudio(result.audio);
      }
    }),
  );
}

/** @deprecated ConversationRelay removed — use voiceTurnPipeline + TwiML Play. */
export async function streamOneChunkToRelay(): Promise<void> {
  throw new Error("ConversationRelay removed — use ElevenLabs Play architecture");
}

/** @deprecated ConversationRelay removed. */
export async function finalizeRelayStream(): Promise<void> {
  throw new Error("ConversationRelay removed — use ElevenLabs Play architecture");
}

/** @deprecated ConversationRelay removed. */
export async function streamChunksToRelay(): Promise<number> {
  throw new Error("ConversationRelay removed — use ElevenLabs Play architecture");
}

/** @deprecated ConversationRelay removed. */
export function buildConversationRelayVoiceAttrs(): Record<string, string> {
  throw new Error("ConversationRelay removed — use direct ElevenLabs API");
}

export type { SpeechChunk };
