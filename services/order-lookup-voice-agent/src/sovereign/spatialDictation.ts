/**
 * Spatial tracking dictation — resume from anchor digits in spatialIndex.
 */
import type { SpatialIndexEntry } from "./activeSession.js";
import { formatTrackingNumberForTTS } from "../utils/ttsFormatter.js";

const DIGIT_WORD: Record<string, string> = {
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

function digitWord(char: string): string {
  return DIGIT_WORD[char] ?? char;
}

/** Extract anchor digit sequence from queries like "3-9", "after 39", "what comes after 3 9". */
export function extractSpatialAnchorDigits(callerText: string): string[] | null {
  const text = callerText.trim();
  if (!text) return null;

  const hyphenMatch = text.match(/(\d(?:\s*[- ]\s*\d)+)/);
  if (hyphenMatch) {
    const digits = hyphenMatch[1].replace(/\D/g, "").split("");
    if (digits.length >= 2) return digits;
  }

  const afterMatch = text.match(
    /\b(?:after|following|past)\s+(?:the\s+)?(\d[\d\s-]{1,20}\d|\d)\b/i,
  );
  if (afterMatch) {
    const digits = afterMatch[1].replace(/\D/g, "").split("");
    if (digits.length >= 1) return digits;
  }

  if (/\b(what comes after|continue from|pick up after)\b/i.test(text)) {
    const trailing = text.match(/(\d(?:\s+\d)+|\d-\d+)\s*$/);
    if (trailing) {
      const digits = trailing[1].replace(/\D/g, "").split("");
      if (digits.length >= 2) return digits;
    }
  }

  return null;
}

export function isSpatialResumeQuery(callerText: string): boolean {
  if (extractSpatialAnchorDigits(callerText)) return true;
  return /\b(what comes after|what comes before|after the|before the|continue from|pick up after|following|prior to|preceding)\b/i.test(
    callerText,
  );
}

export function isSpatialBeforeQuery(callerText: string): boolean {
  return /\b(before|prior to|preceding|comes before)\b/i.test(callerText);
}

function findLatestAnchorStart(
  spatialIndex: SpatialIndexEntry[],
  anchor: string[],
): number {
  if (!anchor.length || !spatialIndex.length) return -1;

  const digits = spatialIndex.map((entry) => entry.digit);
  let lastStart = -1;

  for (let i = 0; i <= digits.length - anchor.length; i += 1) {
    const matches = anchor.every((digit, offset) => digits[i + offset] === digit);
    if (matches) lastStart = i;
  }

  return lastStart;
}

function countAnchorOccurrences(
  spatialIndex: SpatialIndexEntry[],
  anchor: string[],
): number {
  if (!anchor.length || !spatialIndex.length) return 0;

  const digits = spatialIndex.map((entry) => entry.digit);
  let count = 0;

  for (let i = 0; i <= digits.length - anchor.length; i += 1) {
    const matches = anchor.every((digit, offset) => digits[i + offset] === digit);
    if (matches) count += 1;
  }

  return count;
}

function ordinalLabel(n: number): string {
  if (n === 1) return "first";
  if (n === 2) return "second";
  if (n === 3) return "third";
  return `${n}th`;
}

/**
 * Build spatial resume speech from spatialIndex after the latest anchor match.
 * Example: "You are at the second 3-9. The following digits are: Four. One. Five."
 */
export function buildSpatialResumeSpeech(
  spatialIndex: SpatialIndexEntry[],
  anchorDigits: string[],
  trackingRaw?: string,
): string | null {
  const start = findLatestAnchorStart(spatialIndex, anchorDigits);
  if (start < 0) return null;

  const afterStart = start + anchorDigits.length;
  const remaining = spatialIndex.slice(afterStart);
  if (!remaining.length) {
    return "That is the end of the tracking number.";
  }

  const remainingRaw = remaining.map((entry) => entry.digit).join("");
  const phonetic =
    trackingRaw && remainingRaw
      ? formatTrackingNumberForTTS(remainingRaw)
      : remaining.map((entry) => `${digitWord(entry.digit)}.`).join(" ");

  const occurrenceCount = countAnchorOccurrences(spatialIndex, anchorDigits);
  const anchorSpoken = anchorDigits.map((d) => digitWord(d)).join("-");
  const positionHint =
    occurrenceCount > 1
      ? `You are at the ${ordinalLabel(occurrenceCount)} ${anchorSpoken}. `
      : "";

  return `${positionHint}The following digits are: ${phonetic}`;
}

/**
 * Build spatial speech for digits immediately before the latest anchor match.
 */
export function buildSpatialBeforeSpeech(
  spatialIndex: SpatialIndexEntry[],
  anchorDigits: string[],
): string | null {
  const start = findLatestAnchorStart(spatialIndex, anchorDigits);
  if (start < 0) return null;
  if (start === 0) {
    return "There are no digits before that point.";
  }

  const before = spatialIndex.slice(0, start);
  const phonetic = before.map((entry) => `${digitWord(entry.digit)}.`).join(" ");
  const anchorSpoken = anchorDigits.map((d) => digitWord(d)).join("-");
  return `Before ${anchorSpoken}, the digits are: ${phonetic}`;
}
