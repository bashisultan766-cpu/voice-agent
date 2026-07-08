/**
 * Tracking dictation — chunked playback, lastSpokenIndex, spatial resume, and notepad gate.
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
  resolveSpatialTurnSpeech,
} from "../sovereign/spatialDictation.js";

export const USER_NOTEPAD_READY = "USER_NOTEPAD_READY";
export const TRACKING_DICTATION_COMPLETE = "TRACKING_DICTATION_COMPLETE";

export const TRACKING_DICTATION_COMPLETE_SPEECH =
  "Great — sounds like you have the tracking number written down. Would you like help with anything else on your order, or are you looking to buy a book?";

const NOTEPAD_READY_RE =
  /\b(?:ready|i'?m\s+ready|go\s+ahead|all\s+set|you\s+can\s+go)\b/i;

export class NotReadyError extends Error {
  readonly code = "NOTEPAD_NOT_READY" as const;

  constructor(message: string) {
    super(message);
    this.name = "NotReadyError";
  }
}

export function promptUserForNotepad(): string {
  return "Please have your pen and notepad ready. Let me know when you are ready.";
}

export function isUserNotepadReadyIntent(callerText: string): boolean {
  const text = callerText.trim();
  if (!text) return false;
  if (/\b(?:written|wrote|got it|thank|done writing|copied)\b/i.test(text)) return false;
  return NOTEPAD_READY_RE.test(text) || /^(yes|ok|okay)\.?$/i.test(text);
}

export function completeTrackingDictation(callSid: string): void {
  updateActiveSession(callSid, {
    currentState: "order_active",
    awaitingClarification: null,
    cachedIntent: "order",
    lastSpokenIndex: -1,
    lastDictationIndex: -1,
    isNotepadReady: false,
  });
}

export type DictateTrackingSuccess = {
  ok: true;
  intent: typeof USER_NOTEPAD_READY;
  speech: string;
};

export type DictateTrackingBlocked = {
  ok: false;
  error: NotReadyError;
};

export type DictateTrackingResult = DictateTrackingSuccess | DictateTrackingBlocked;

/**
 * Hard notepad gate — tracking dictation only after USER_NOTEPAD_READY.
 * Returns NotReadyError (with promptUserForNotepad speech) when caller has not confirmed readiness.
 */
export function dictateTracking(callSid: string): DictateTrackingResult {
  const active = getOrCreateActiveSession(callSid);
  const trackingForTts = active.lastSpokenPayload?.trackingForTts?.trim();

  if (!trackingForTts) {
    return {
      ok: false,
      error: new NotReadyError(
        "I do not have a tracking number on file yet. Would you like me to look up your order?",
      ),
    };
  }

  if (!active.isNotepadReady) {
    markTrackingAwaitingNotepad(callSid);
    return {
      ok: false,
      error: new NotReadyError(promptUserForNotepad()),
    };
  }

  updateActiveSession(callSid, {
    currentState: "tracking_dictation",
    awaitingClarification: null,
    lastDictationIndex: -1,
  });

  return {
    ok: true,
    intent: USER_NOTEPAD_READY,
    speech: trackingForTts,
  };
}

export function confirmUserNotepadReady(callSid: string): void {
  updateActiveSession(callSid, {
    isNotepadReady: true,
    awaitingClarification: null,
    currentState: "tracking_dictation",
    lastSpokenIndex: -1,
  });
}

export function markTrackingAwaitingNotepad(callSid: string): void {
  updateActiveSession(callSid, {
    currentState: "awaiting_notepad_ready",
    awaitingClarification: "notepad_ready",
    lastDictationIndex: -1,
    lastSpokenIndex: -1,
    isNotepadReady: false,
  });
}

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
  const turn = resolveSpatialTurnSpeech(
    callerText,
    active.spatialIndex,
    active.lastSpokenPayload?.trackingRaw,
  );
  return turn.handled ? (turn.speech ?? null) : null;
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
