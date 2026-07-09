/**
 * Spatial tracking dictation — resume from anchor digits in spatialIndex.
 */
import type { SpatialIndexEntry } from "./activeSession.js";

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

function digitsFromFragment(fragment: string): string[] {
  return fragment
    .replace(/\band\b/gi, " ")
    .replace(/\D/g, "")
    .split("")
    .filter(Boolean);
}

/**
 * Extract anchor digit sequence from voice/STT queries.
 * Supports "3-9", "3,9", "7,8,9,3,9", "after 3 9", "what comes after 0,0,0".
 */
export function extractSpatialAnchorDigits(callerText: string): string[] | null {
  const text = callerText.trim();
  if (!text) return null;

  const afterClause = text.match(
    /\b(?:what\s+comes\s+after|what\s+comes\s+before|after|following|past|before|prior\s+to|preceding)\s+(?:the\s+)?(.+?)(?:\?|$)/i,
  );
  if (afterClause) {
    const digits = digitsFromFragment(afterClause[1]);
    if (digits.length) return digits;
  }

  const hyphenMatch = text.match(/(\d(?:\s*[- ]\s*\d)+)/);
  if (hyphenMatch) {
    const digits = digitsFromFragment(hyphenMatch[1]);
    if (digits.length >= 2) return digits;
  }

  const commaOrSpaceRun = text.match(/([\d](?:[\s,.-]*\d)+)\s*$/);
  if (commaOrSpaceRun) {
    const digits = digitsFromFragment(commaOrSpaceRun[1]);
    if (digits.length >= 1) return digits;
  }

  const afterMatch = text.match(
    /\b(?:after|following|past)\s+(?:the\s+)?(\d[\d\s,.\-]{0,48}\d|\d)\b/i,
  );
  if (afterMatch) {
    const digits = digitsFromFragment(afterMatch[1]);
    if (digits.length >= 1) return digits;
  }

  if (/\b(what comes after|continue from|pick up after)\b/i.test(text)) {
    const trailing = text.match(/([\d](?:[\s,.-]*\d)+|\d-\d+)\s*$/);
    if (trailing) {
      const digits = digitsFromFragment(trailing[1]);
      if (digits.length >= 1) return digits;
    }
  }

  return null;
}

export function isSpatialResumeQuery(callerText: string): boolean {
  const text = callerText.trim();
  if (
    /\b(?:order\s+number|lookup\s+(?:my\s+)?order|find\s+(?:my\s+)?order|check\s+(?:my\s+)?order|order\s+status|track\s+my\s+order)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  if (extractSpatialAnchorDigits(callerText)) return true;
  return /\b(what comes after|what comes before|after the|before the|continue from|pick up after|following|prior to|preceding|comes after|comes before)\b/i.test(
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

function findLatestAnchorEnd(
  spatialIndex: SpatialIndexEntry[],
  anchor: string[],
): number {
  const contiguousStart = findLatestAnchorStart(spatialIndex, anchor);
  if (contiguousStart >= 0) return contiguousStart + anchor.length - 1;

  const digits = spatialIndex.map((entry) => entry.digit);
  let bestEnd = -1;
  for (let startIdx = 0; startIdx < digits.length; startIdx += 1) {
    let anchorIdx = 0;
    let endIdx = -1;
    for (let i = startIdx; i < digits.length; i += 1) {
      if (digits[i] === anchor[anchorIdx]) {
        endIdx = i;
        anchorIdx += 1;
        if (anchorIdx === anchor.length) break;
      }
    }
    if (anchorIdx === anchor.length && endIdx > bestEnd) {
      bestEnd = endIdx;
    }
  }
  return bestEnd;
}

/** Pick the anchor suffix that actually appears in the tracking number (prefer latest match). */
export function resolveAnchorDigitsForSpatialIndex(
  spatialIndex: SpatialIndexEntry[],
  candidate: string[],
): string[] | null {
  if (!candidate.length || !spatialIndex.length) return null;

  const attempts: string[][] = [];
  for (let len = candidate.length; len >= 1; len -= 1) {
    attempts.push(candidate.slice(-len));
  }
  if (candidate.length > 1 && !attempts.some((a) => a.length === candidate.length)) {
    attempts.push(candidate);
  }

  for (const anchor of attempts) {
    if (findLatestAnchorEnd(spatialIndex, anchor) >= 0) return anchor;
  }

  return candidate;
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
  _trackingRaw?: string,
): string | null {
  const anchor =
    resolveAnchorDigitsForSpatialIndex(spatialIndex, anchorDigits) ?? anchorDigits;
  const anchorEnd = findLatestAnchorEnd(spatialIndex, anchor);
  if (anchorEnd < 0) return null;

  const afterStart = anchorEnd + 1;
  const remaining = spatialIndex.slice(afterStart);
  if (!remaining.length) {
    return "That is the end of the tracking number.";
  }

  const phonetic = remaining.map((entry) => `${digitWord(entry.digit)}.`).join(" ");

  const occurrenceCount = countAnchorOccurrences(spatialIndex, anchor);
  const anchorSpoken = anchor.map((d) => digitWord(d)).join("-");
  const positionHint =
    occurrenceCount > 1
      ? `You are at the ${ordinalLabel(occurrenceCount)} ${anchorSpoken}. `
      : "";

  return `${positionHint}After ${anchorSpoken}, the digits are: ${phonetic}`;
}

/**
 * Build spatial speech for digits immediately before the latest anchor match.
 */
export function buildSpatialBeforeSpeech(
  spatialIndex: SpatialIndexEntry[],
  anchorDigits: string[],
): string | null {
  const anchor =
    resolveAnchorDigitsForSpatialIndex(spatialIndex, anchorDigits) ?? anchorDigits;
  const start = findLatestAnchorStart(spatialIndex, anchor);
  if (start < 0) return null;
  if (start === 0) {
    return "There are no digits before that point.";
  }

  const before = spatialIndex.slice(0, start);
  const phonetic = before.map((entry) => `${digitWord(entry.digit)}.`).join(" ");
  const anchorSpoken = anchor.map((d) => digitWord(d)).join("-");
  return `Before ${anchorSpoken}, the digits are: ${phonetic}`;
}

export interface SpatialTurnResolution {
  handled: boolean;
  speech?: string;
  anchor?: string[];
  resumeOffset?: number;
}

/** Deterministic spatial turn — used by orchestrator and LLM safety net. */
export function resolveSpatialTurnSpeech(
  callerText: string,
  spatialIndex: SpatialIndexEntry[],
  trackingRaw?: string,
): SpatialTurnResolution {
  if (!spatialIndex.length || !isSpatialResumeQuery(callerText)) {
    return { handled: false };
  }

  const rawAnchor = extractSpatialAnchorDigits(callerText);
  if (!rawAnchor?.length) {
    return {
      handled: true,
      speech:
        "Which digits should I continue from? For example, say what comes after 3 dash 9.",
    };
  }

  const anchor = resolveAnchorDigitsForSpatialIndex(spatialIndex, rawAnchor) ?? rawAnchor;
  const speech = isSpatialBeforeQuery(callerText)
    ? buildSpatialBeforeSpeech(spatialIndex, anchor)
    : buildSpatialResumeSpeech(spatialIndex, anchor, trackingRaw);

  if (!speech) {
    return {
      handled: true,
      speech:
        "I could not find that position in the tracking number. Please repeat the digits you want me to continue from.",
      anchor,
    };
  }

  const start = findLatestAnchorStart(spatialIndex, anchor);
  const anchorEnd = start >= 0 ? start + anchor.length - 1 : findLatestAnchorEnd(spatialIndex, anchor);
  if (anchorEnd < 0) {
    return {
      handled: true,
      speech:
        "I could not find that position in the tracking number. Please repeat the digits you want me to continue from.",
      anchor,
    };
  }

  const resumeOffset = isSpatialBeforeQuery(callerText)
    ? Math.max(start, 0)
    : anchorEnd + 1;

  return {
    handled: true,
    speech,
    anchor,
    resumeOffset: resumeOffset >= 0 ? resumeOffset : undefined,
  };
}
