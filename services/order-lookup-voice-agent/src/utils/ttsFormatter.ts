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

export type TrackingDictationSpeed = "slow" | "normal";

export interface FormatTrackingNumberOptions {
  /** Legacy opt-in — SSML breaks are often stripped on voice relays; ellipsis pacing is default. */
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

/** Pause separator between spoken digit words — never commas or dashes (TTS reads those aloud). */
const DIGIT_PAUSE_SEP = "... ";

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

function charToPhoneticWord(char: string): string {
  if (DIGIT_PHONETIC[char]) return DIGIT_PHONETIC[char];
  if (/[A-Z]/.test(char)) return char;
  // Never speak "Dash" — hyphens become silent pauses via separator only.
  if (char === "-") return "";
  return char;
}

function charToPhoneticPacing(char: string): string {
  const word = charToPhoneticWord(char);
  return word ? `${word}.` : "";
}

/** Phonetic pacing for a raw digit run (e.g. spatial resume chunk "02" → "Zero... Two"). */
export function formatTrackingChunkPhonetic(sequence: string): string {
  const normalized = normalizeTrackingIdRawSequence(sequence);
  if (!normalized) return "";
  return [...normalized]
    .map(charToPhoneticWord)
    .filter(Boolean)
    .join(DIGIT_PAUSE_SEP);
}

export function formatTrackingChunkForTts(
  sequence: string,
  options?: { useCharacterSsml?: boolean },
): string {
  if (options?.useCharacterSsml) {
    return wrapTrackingChunkSsml(sequence);
  }
  return formatTrackingChunkPhonetic(sequence);
}

function formatPhoneticAcousticPacing(chars: string[], separator = DIGIT_PAUSE_SEP): string {
  if (!chars.length) return "";
  return chars.map(charToPhoneticWord).filter(Boolean).join(separator);
}

/** Extra-slow replay when the caller asks to repeat / go slower. */
export function formatTrackingNumberForTTSSlower(trackingId: string): string {
  const normalized = normalizeTrackingIdRawSequence(trackingId);
  if (!normalized) return "";
  const chars = [...normalized];
  if (chars.every((c) => c >= "0" && c <= "9")) {
    return chars.map((c) => DIGIT_PHONETIC[c] ?? c).join("...  ");
  }
  return formatPhoneticAcousticPacing(chars, "...  ");
}

/**
 * Format a tracking ID for extremely slow, clear TTS dictation.
 * Uses spoken digit words with ellipsis pauses ("One... Two... Three...") —
 * never commas or dashes (TTS would say "comma" / "dash").
 * SSML breaks are opt-in only — they are often stripped or ignored on voice relays.
 */
export function formatTrackingNumberForTTS(
  trackingId: string,
  _speed: TrackingDictationSpeed = "slow",
  options?: FormatTrackingNumberOptions,
): string {
  const normalized = normalizeTrackingIdRawSequence(trackingId);
  if (!normalized) return "";

  const chars = [...normalized];

  if (options?.useSsml === true) {
    const breakTime = formatSsmlBreakTime(pauseMsForSpeed(_speed));
    return chars.map((char) => `${char}<break time="${breakTime}"/>`).join("");
  }

  // Pure digit IDs: pause-only spoken words ("944901" → "Nine... Four... Four... Nine... Zero... One").
  if (chars.every((c) => c >= "0" && c <= "9")) {
    return chars.map((c) => DIGIT_PHONETIC[c] ?? c).join(DIGIT_PAUSE_SEP);
  }

  return formatPhoneticAcousticPacing(chars);
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

function spokenDigitRunToPhonetic(digitRun: string): string {
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
  return chars.map((ch) => charToPhoneticWord(ch)).filter(Boolean).join("... ");
}

/** Remove decimal/math phrasing from tracking dictation speech (e.g. "point 02" → "Zero, Two"). */
export function sanitizeTrackingDictationSpeech(text: string): string {
  if (!text?.trim()) return "";

  let out = text.replace(/(\d)\.(\d)/g, "$1 $2");

  out = out.replace(
    /\bpoint\s+((?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\.?[\s,.-]*)+|\d[\d\s,.]*)/gi,
    (_match, digitRun: string) => spokenDigitRunToPhonetic(digitRun),
  );

  out = out.replace(/\bpoint\s+(?=\d)/gi, "");

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
