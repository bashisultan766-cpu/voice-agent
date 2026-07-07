/**
 * Tracking dictation — chunked playback, lastSpokenIndex, and spatial resume.
 */
import type { SpeechChunk } from "../types/order.js";
import type { ActiveSession, SpatialIndexEntry } from "../sovereign/activeSession.js";
import {
  buildSpatialResumeFromIndex,
  getOrCreateActiveSession,
  recordDictationProgress,
  updateActiveSession,
} from "../sovereign/activeSession.js";
import {
  buildSpatialResumeSpeech,
  extractSpatialAnchorDigits,
  isSpatialResumeQuery,
} from "../sovereign/spatialDictation.js";

export const TRACKING_DICTATION_CHUNK_SIZE = 4;

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

function entryToSpeech(entry: SpatialIndexEntry): string {
  if (entry.digit >= "0" && entry.digit <= "9") {
    return `${digitWord(entry.digit)}.`;
  }
  if (entry.digit === "-") return "Dash.";
  return `${entry.digit}.`;
}

/** Character index in spatialIndex for the last spoken digit (-1 = none). */
export function getLastSpokenIndex(callSid: string): number {
  return getOrCreateActiveSession(callSid).lastSpokenIndex;
}

export function setLastSpokenIndex(callSid: string, index: number): void {
  updateActiveSession(callSid, { lastSpokenIndex: index });
  recordDictationProgress(callSid, index);
}

/**
 * Break tracking into chunks (default 4 digits) with pauses between each.
 * Resumes from startIndex when caller interrupted mid-dictation.
 */
export function buildTrackingDictationChunks(
  spatialIndex: SpatialIndexEntry[],
  startIndex = 0,
  chunkSize = TRACKING_DICTATION_CHUNK_SIZE,
): SpeechChunk[] {
  if (!spatialIndex.length || startIndex >= spatialIndex.length) return [];

  const chunks: SpeechChunk[] = [];
  for (let i = startIndex; i < spatialIndex.length; i += chunkSize) {
    const slice = spatialIndex.slice(i, i + chunkSize);
    const text = slice.map(entryToSpeech).join(" ");
    const endIndex = Math.min(i + chunkSize - 1, spatialIndex.length - 1);
    const isLast = i + chunkSize >= spatialIndex.length;
    chunks.push({
      text,
      kind: "dictation",
      pauseMs: isLast ? 0 : 600,
      preserveFull: true,
      dictationEndIndex: endIndex,
    });
  }
  return chunks;
}

/** End index (inclusive) of the spatial chunk starting at startIndex. */
export function chunkEndIndex(
  spatialIndex: SpatialIndexEntry[],
  startIndex: number,
  chunkSize = TRACKING_DICTATION_CHUNK_SIZE,
): number {
  if (!spatialIndex.length || startIndex >= spatialIndex.length) return startIndex;
  return Math.min(startIndex + chunkSize - 1, spatialIndex.length - 1);
}

/**
 * Resume dictation after spatial query like "what is after 7-8?".
 * Returns speech from the character after the anchor, or null.
 */
export function resolveSpatialResumeFromQuery(
  callerText: string,
  active: ActiveSession,
): string | null {
  if (!active.spatialIndex.length) return null;

  if (isSpatialResumeQuery(callerText)) {
    const anchor = extractSpatialAnchorDigits(callerText);
    if (anchor) {
      return buildSpatialResumeSpeech(
        active.spatialIndex,
        anchor,
        active.lastSpokenPayload?.trackingRaw,
      );
    }
  }

  return null;
}

/**
 * Resume from lastSpokenIndex after interrupt — continues from next digit.
 */
export function buildResumeFromLastSpokenIndex(active: ActiveSession): string | null {
  if (active.lastSpokenIndex < 0 || !active.spatialIndex.length) return null;
  return buildSpatialResumeFromIndex(active.spatialIndex, active.lastSpokenIndex);
}

/** Index to resume dictation chunks after a spatial anchor query. */
export function calculateResumeOffset(
  spatialIndex: SpatialIndexEntry[],
  anchorDigits: string[],
): number {
  if (!anchorDigits.length || !spatialIndex.length) return 0;

  const digits = spatialIndex.map((entry) => entry.digit);
  let lastStart = -1;
  for (let i = 0; i <= digits.length - anchorDigits.length; i += 1) {
    const matches = anchorDigits.every((digit, offset) => digits[i + offset] === digit);
    if (matches) lastStart = i;
  }

  if (lastStart < 0) return 0;
  return lastStart + anchorDigits.length;
}
