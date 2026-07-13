import { normalizeTrackingIdRawSequence } from "./trackingIdSequence.js";
import { wrapTrackingChunkSsml } from "./formatter.js";
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

/** Comma+space separator for long numeric / tracking sequences (TTS pacing). */
export const DIGIT_COMMA_SEP = ", ";

/** Sequences longer than this use mandatory comma pacing. */
export const COMMA_PACING_MIN_LENGTH = 5;

export type TrackingDictationSpeed = "slow" | "normal";

export interface FormatTrackingNumberOptions {
  /** Legacy opt-in — SSML breaks are often stripped on voice relays; comma pacing is default. */
  useSsml?: boolean;
}

const SSML_BREAK_TAG_RE = /<break\s+time=["']([^"']+)["']\s*\/?>/gi;

const TRACKING_DICTATION_SSML_RE = /<break\s+time=/i;
const TRACKING_DICTATION_PHONETIC_RE =
  /\b(Zero|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ay|Bee|Cee|Dee|Eee|Ef|Gee|Aitch|Eye|Jay|Kay|El|Em|En|Oh|Pea|Cue|Ar|Ess|Tee|You|Vee|Double-you|Ex|Why|Zee)(?:\.\.\.|\.|\s*-)/i;
const TRACKING_DICTATION_COMMA_RE = /[A-Z0-9],\s+[A-Z0-9]/i;
const TRACKING_DICTATION_ELLIPSIS_RE =
  /\b(Zero|One|Two|Three|Four|Five|Six|Seven|Eight|Nine)\.\.\./i;
const TRACKING_DICTATION_DASH_RE = /\d\s+-\s+\d/;

const DIGIT_PHONETIC: Record<string, string> = {
  "0": "Zero",
  "1": "One",
  "2": "Two",
  "3": "Three",
  "4": "Four",
  "5": "Five",
  "6": "Six",
  "7": "Seven",
  "8": "Eight",
  "9": "Nine",
};

/** Strip hyphens, dashes, and points — Zero Punctuation for spoken IDs. */
export function stripSpokenPunctuation(raw: string): string {
  return String(raw ?? "")
    .replace(/[.\u2026]/g, "")
    .replace(/[-–—]/g, "")
    .trim();
}

/** Normalize a tracking / order ID for spoken dictation (no hyphens/dashes/points). */
export function normalizeSpokenIdSequence(raw: string): string {
  return stripSpokenPunctuation(normalizeTrackingIdRawSequence(raw)).replace(
    /[^0-9A-Za-z]/g,
    "",
  );
}

function charToSpokenToken(char: string): string {
  if (!char || char === "-" || char === "." || char === "–" || char === "—") return "";
  return char;
}

/**
 * Comma-pace characters when the sequence is longer than 5 digits/chars.
 * Example: "944901" → "9, 4, 4, 9, 0, 1"
 */
export function formatWithCommaPacing(sequence: string): string {
  const normalized = normalizeSpokenIdSequence(sequence);
  if (!normalized) return "";
  const chars = [...normalized].map(charToSpokenToken).filter(Boolean);
  if (!chars.length) return "";
  if (chars.length > COMMA_PACING_MIN_LENGTH) {
    return chars.join(DIGIT_COMMA_SEP);
  }
  return chars.join(DIGIT_COMMA_SEP);
}

/**
 * Precision slice: return ONLY the remainder of a cached ID after an anchor.
 * e.g. sliceTrackingRemainderAfterAnchor("944901188300", "47") → "901188300" if "47" appears…
 * Uses the first occurrence of the anchor digit run.
 */
export function sliceTrackingRemainderAfterAnchor(
  trackingId: string,
  anchor: string,
): string {
  const normalized = normalizeSpokenIdSequence(trackingId);
  const anchorNorm = normalizeSpokenIdSequence(anchor);
  if (!normalized || !anchorNorm) return "";
  const idx = normalized.indexOf(anchorNorm);
  if (idx < 0) return "";
  return normalized.slice(idx + anchorNorm.length);
}

/** Format the remainder after an anchor with comma pacing (empty if no match / no remainder). */
export function formatTrackingRemainderAfterAnchor(
  trackingId: string,
  anchor: string,
): string {
  const remainder = sliceTrackingRemainderAfterAnchor(trackingId, anchor);
  return remainder ? formatWithCommaPacing(remainder) : "";
}

function charToPhoneticWord(char: string): string {
  if (DIGIT_PHONETIC[char]) return DIGIT_PHONETIC[char];
  if (/[A-Z]/i.test(char)) return char.toUpperCase();
  return "";
}

/** Phonetic pacing for a raw digit run — comma-separated spoken words when long. */
export function formatTrackingChunkPhonetic(sequence: string): string {
  const normalized = normalizeSpokenIdSequence(sequence);
  if (!normalized) return "";
  return [...normalized]
    .map(charToPhoneticWord)
    .filter(Boolean)
    .join(DIGIT_COMMA_SEP);
}

export function formatTrackingChunkForTts(
  sequence: string,
  options?: { useCharacterSsml?: boolean },
): string {
  if (options?.useCharacterSsml) {
    return wrapTrackingChunkSsml(sequence);
  }
  return formatWithCommaPacing(sequence);
}

/** Extra-slow replay when the caller asks to repeat / go slower. */
export function formatTrackingNumberForTTSSlower(trackingId: string): string {
  const normalized = normalizeSpokenIdSequence(trackingId);
  if (!normalized) return "";
  // Wider pause: double-space after commas for slower delivery.
  return [...normalized].join(",  ");
}

/**
 * Format a tracking ID for clear TTS dictation.
 * Comma pacing for sequences longer than 5 digits; Zero Punctuation (no hyphens/dashes/points).
 * SSML breaks are opt-in only — they are often stripped or ignored on voice relays.
 */
export function formatTrackingNumberForTTS(
  trackingId: string,
  _speed: TrackingDictationSpeed = "slow",
  options?: FormatTrackingNumberOptions,
): string {
  const normalized = normalizeSpokenIdSequence(trackingId);
  if (!normalized) return "";

  const chars = [...normalized];

  if (options?.useSsml === true) {
    const breakTime = formatSsmlBreakTime(pauseMsForSpeed(_speed));
    return chars.map((char) => `${char}<break time="${breakTime}"/>`).join("");
  }

  return formatWithCommaPacing(normalized);
}

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
  return sanitizeTrackingDictationSpeech(sanitizeSsmlForTTS(text.trim()));
}

const SPOKEN_DIGIT_TO_CHAR: Record<string, string> = {
  zero: "0",
  oh: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

function spokenDigitRunToCommaPaced(digitRun: string): string {
  const tokens = digitRun
    .toLowerCase()
    .replace(/\./g, " ")
    .split(/[\s,]+/)
    .filter(Boolean);
  const chars: string[] = [];
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      chars.push(...token.split(""));
      continue;
    }
    const mapped = SPOKEN_DIGIT_TO_CHAR[token];
    if (mapped) chars.push(mapped);
  }
  return formatWithCommaPacing(chars.join(""));
}

/** Remove decimal/math phrasing from tracking dictation speech (e.g. "point 02" → "0, 2"). */
export function sanitizeTrackingDictationSpeech(text: string): string {
  if (!text?.trim()) return "";

  let out = text.replace(/(\d)\.(\d)/g, "$1 $2");

  out = out.replace(
    /\bpoint\s+((?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\.?[\s,.-]*)+|\d[\d\s,.]*)/gi,
    (_match, digitRun: string) => spokenDigitRunToCommaPaced(digitRun),
  );

  out = out.replace(/\bpoint\s+(?=\d)/gi, "");

  // Zero Punctuation: strip residual hyphens/dashes from spoken digit runs.
  out = out.replace(/(\d)\s*[-–—]\s*(\d)/g, `$1${DIGIT_COMMA_SEP}$2`);

  return out.trim();
}

/** True when speech contains intentional tracking-number dictation formatting. */
export function isTrackingDictationText(text: string): boolean {
  if (!text?.trim()) return false;
  return (
    TRACKING_DICTATION_SSML_RE.test(text) ||
    TRACKING_DICTATION_PHONETIC_RE.test(text) ||
    TRACKING_DICTATION_ELLIPSIS_RE.test(text) ||
    TRACKING_DICTATION_COMMA_RE.test(text) ||
    TRACKING_DICTATION_DASH_RE.test(text)
  );
}

function pauseMsForSpeed(speed: TrackingDictationSpeed): number {
  return speed === "slow" ? TRACKING_CHAR_PAUSE_SLOW_MS : TRACKING_CHAR_PAUSE_NORMAL_MS;
}
