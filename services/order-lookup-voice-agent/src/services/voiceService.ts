import { synthesizeSpeech, type VoiceSynthesisResult } from "../adapters/ttsAdapter.js";
import { smoothForVoice } from "./voiceSmoothingEngine.js";
import { isTrackingDictationText, sanitizeTextForTTS } from "../utils/ttsFormatter.js";
import { getCachedPhrase } from "../utils/phraseCache.js";

export type { VoiceSynthesisResult };

const chunkAudioCache = new Map<string, VoiceSynthesisResult>();

/**
 * Direct TTS synthesis — one sentence per request for cache prewarm.
 * Live calls stream μ-law audio over Twilio Media Streams (see mediaStreamVoice).
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

/** Light prosody + rhythm smoothing before OpenAI/ElevenLabs synthesis. */
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

export async function prewarmVoiceCache(): Promise<void> {
  const phrases = [
    getCachedPhrase("found_order"),
    getCachedPhrase("closing_question"),
    getCachedPhrase("follow_up"),
    getCachedPhrase("goodbye"),
  ];
  await Promise.all(phrases.map((p) => synthesizeSpeechChunk(p)));
}
