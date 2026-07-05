/**
 * Voice Smoothing Engine — prepares LLM text for natural ElevenLabs delivery.
 * Shopify = truth, LLM = reasoning, this module = delivery layer.
 */
import type { SpeechChunk, SpeechChunkKind } from "../types/order.js";

const PAUSE_MIN_MS = 80;
const PAUSE_MAX_MS = 150;
const MAX_WORDS_PER_CHUNK = 14;
const DEFAULT_MAX_SENTENCES = 4;

export interface SmoothForVoiceOptions {
  /** Keep every sentence — required for full proactive order summaries. */
  preserveFull?: boolean;
}

const CONVERSATIONAL_REPLACEMENTS: Array<[RegExp, string]> = [
  [/^I found your order\.?/i, "Great — I found your order."],
  [/^Your order (?:is|was) found\.?/i, "Great — I found your order."],
  [/\bIt contains (\d+) items?\.?/i, "It has $1 items."],
  [/\bThe total is\b/i, "The total was"],
  [/\bTotal is\b/i, "The total was"],
  [/\bUSD\b/gi, "dollars"],
];

export function normalizePunctuation(text: string): string {
  return text
    .replace(/\s*([,.!?;:])\s*/g, "$1 ")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    .replace(/\s+([.!?])/g, "$1")
    .trim();
}

export function mergeBrokenSentences(text: string): string {
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length <= 1) return text.trim();

  const merged: string[] = [];
  for (const part of parts) {
    const prev = merged[merged.length - 1];
    if (prev && prev.length < 24 && !/[.!?]$/.test(prev)) {
      merged[merged.length - 1] = `${prev} ${part}`;
    } else {
      merged.push(part);
    }
  }

  return merged.join(" ");
}

export function conversationalize(text: string): string {
  let out = text.trim();
  for (const [pattern, replacement] of CONVERSATIONAL_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out.trim();
}

/** Full text cleanup before TTS — one idea per sentence, natural phrasing. */
export function smoothForVoice(text: string, options?: SmoothForVoiceOptions): string {
  if (!text?.trim()) return "";

  let cleaned = text.trim();
  cleaned = cleaned.replace(/\s*—\s*/g, ", ");
  cleaned = mergeBrokenSentences(cleaned);
  cleaned = normalizePunctuation(cleaned);
  cleaned = conversationalize(cleaned);

  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) =>
      options?.preserveFull || s.length <= 120 ? s : `${s.slice(0, 117).trim()}...`,
    );

  if (options?.preserveFull) {
    return sentences.join(" ");
  }

  return sentences.slice(0, DEFAULT_MAX_SENTENCES).join(" ");
}

function pauseForChunk(index: number, total: number): number {
  if (index >= total - 1) return 0;
  const spread = PAUSE_MAX_MS - PAUSE_MIN_MS;
  return PAUSE_MIN_MS + (index % 3) * Math.floor(spread / 3);
}

function splitLongSentence(sentence: string): string[] {
  const words = sentence.trim().split(/\s+/);
  if (words.length <= MAX_WORDS_PER_CHUNK) return [sentence.trim()];

  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += MAX_WORDS_PER_CHUNK) {
    chunks.push(words.slice(i, i + MAX_WORDS_PER_CHUNK).join(" "));
  }
  return chunks;
}

/** Short sentence chunks with controlled micro-pauses for ConversationRelay. */
export function splitIntoSmoothedChunks(
  text: string,
  options?: SmoothForVoiceOptions,
): Array<{ text: string; pauseMs: number }> {
  const smooth = smoothForVoice(text, options);
  if (!smooth) return [];

  const sentences = smooth
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const pieces = options?.preserveFull
    ? sentences
    : sentences.flatMap(splitLongSentence);
  return pieces.map((piece, index) => ({
    text: piece,
    pauseMs: pauseForChunk(index, pieces.length),
  }));
}

export function speechChunksFromText(
  text: string,
  kind: SpeechChunkKind = "summary",
  options?: SmoothForVoiceOptions,
): SpeechChunk[] {
  if (kind === "dictation") {
    const trimmed = text.trim();
    if (!trimmed) return [];
    return [{ text: trimmed, kind: "dictation", pauseMs: 0, preserveFull: true }];
  }

  return splitIntoSmoothedChunks(text, options).map((chunk) => ({
    text: chunk.text,
    kind,
    pauseMs: chunk.pauseMs,
    preserveFull: options?.preserveFull,
  }));
}
