/**
 * TTS formatting helpers — slow dictation for alphanumeric IDs on voice calls.
 */
import { getConfig } from "../config.js";

/**
 * Voice-friendly email handle for refund/confirmation readout.
 * Returns the local part before @ with trailing digits stripped
 * (e.g. jamaicathompson87@gmail.com → "jamaicathompson").
 */
export function formatEmailHandleForTTS(
  email: string | null | undefined,
): string | null {
  if (!email?.trim()) return null;
  const local = email.trim().match(/^([^@]+)@/)?.[1]?.toLowerCase();
  if (!local) return null;
  return local.replace(/\d+$/, "") || local;
}

/**
 * Full speakable email for phone readout — never includes staff timeline names.
 * e.g. jamaicathompson87@gmail.com → "jamaicathompson87 at gmail dot com"
 */
export function formatEmailForTTS(email: string | null | undefined): string | null {
  if (!email?.trim()) return null;
  const trimmed = email.trim();
  const at = trimmed.indexOf("@");
  if (at <= 0) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).replace(/\./g, " dot ");
  return `${local} at ${domain}`;
}

/** Hard ceiling for SSML break tags — ElevenLabs/OpenAI drop connections above ~1s. */
export const SSML_BREAK_MAX_MS = 1000;

/** Safe per-character pause for slow tracking dictation. */
export const SSML_BREAK_SAFE_MS = 800;

export const TRACKING_CHAR_PAUSE_SLOW_MS = SSML_BREAK_SAFE_MS;
export const TRACKING_CHAR_PAUSE_NORMAL_MS = 500;

export type TrackingDictationSpeed = "slow" | "normal";

export interface FormatTrackingNumberOptions {
  /** Override config — SSML breaks for ElevenLabs; comma spacing otherwise. */
  useSsml?: boolean;
}

const SSML_BREAK_TAG_RE = /<break\s+time=["']([^"']+)["']\s*\/?>/gi;

const TRACKING_DICTATION_SSML_RE = /<break\s+time=/i;
const TRACKING_DICTATION_PUNCT_RE = /\b[A-Z0-9]\s*,\s*\.\s*,/i;

/** Parse an SSML break duration string (e.g. "500ms", "2s", "1.5s") into milliseconds. */
export function parseSsmlBreakTimeMs(raw: string): number {
  const trimmed = raw.trim().toLowerCase();
  const msMatch = trimmed.match(/^([\d.]+)\s*ms$/);
  if (msMatch) return Math.round(parseFloat(msMatch[1]));

  const sMatch = trimmed.match(/^([\d.]+)\s*s(?:ec(?:ond)?s?)?$/);
  if (sMatch) return Math.round(parseFloat(sMatch[1]) * 1000);

  const bare = trimmed.match(/^([\d.]+)$/);
  if (bare) {
    const n = parseFloat(bare[1]);
    return n <= 10 ? Math.round(n * 1000) : Math.round(n);
  }

  return SSML_BREAK_MAX_MS;
}

/** Format a clamped break duration for SSML output. */
export function formatSsmlBreakTime(ms: number): string {
  const clamped = Math.min(Math.max(ms, 0), SSML_BREAK_MAX_MS);
  if (clamped >= 1000) return "1s";
  return `${clamped}ms`;
}

/**
 * Clamp a single SSML break duration to safe limits (max 1s / 800ms recommended).
 */
export function clampSsmlBreakTime(raw: string, maxMs = SSML_BREAK_MAX_MS): string {
  const parsed = parseSsmlBreakTimeMs(raw);
  return formatSsmlBreakTime(Math.min(parsed, maxMs));
}

/**
 * Sanitize LLM-generated SSML before TTS — forcefully clamp dangerously long pauses.
 * e.g. `<break time="5000ms"/>` → `<break time="1s"/>`
 */
export function sanitizeSsmlForTTS(text: string): string {
  return text.replace(SSML_BREAK_TAG_RE, (_match, timeVal: string) => {
    return `<break time="${clampSsmlBreakTime(timeVal)}"/>`;
  });
}

/** Sanitize all text destined for TTS engines (SSML breaks + strip unknown tags). */
export function sanitizeTextForTTS(text: string): string {
  if (!text?.trim()) return "";
  return sanitizeSsmlForTTS(text.trim());
}

/** True when speech contains intentional tracking-number dictation formatting. */
export function isTrackingDictationText(text: string): boolean {
  if (!text?.trim()) return false;
  return TRACKING_DICTATION_SSML_RE.test(text) || TRACKING_DICTATION_PUNCT_RE.test(text);
}

function pauseMsForSpeed(speed: TrackingDictationSpeed): number {
  return speed === "slow" ? TRACKING_CHAR_PAUSE_SLOW_MS : TRACKING_CHAR_PAUSE_NORMAL_MS;
}

function formatPhoneticDictation(chars: string[], speed: TrackingDictationSpeed): string {
  const pauseToken = speed === "slow" ? ". ," : " ,";
  return chars.map((char) => `${char}${pauseToken}`).join(" ");
}

/**
 * Format a tracking ID for extremely slow, clear TTS dictation.
 * ElevenLabs / Twilio ConversationRelay: SSML pause between every character (≤800ms).
 * Other engines: phonetic spelling with safe punctuation pauses.
 */
export function formatTrackingNumberForTTS(
  trackingId: string,
  speed: TrackingDictationSpeed = "slow",
  options?: FormatTrackingNumberOptions,
): string {
  const normalized = trackingId.trim().toUpperCase();
  if (!normalized) return "";

  const chars = [...normalized];
  const pauseMs = pauseMsForSpeed(speed);
  const useSsml =
    options?.useSsml ??
    getConfig().VOICE_TTS_PROVIDER.toLowerCase() === "elevenlabs";

  if (useSsml) {
    const breakTime = formatSsmlBreakTime(pauseMs);
    return chars.map((char) => `${char}<break time="${breakTime}"/>`).join("");
  }

  return formatPhoneticDictation(chars, speed);
}
