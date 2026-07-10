/**
 * Tracking dictation — chunked playback, lastSpokenIndex, spatial resume, and notepad gate.
 */
import type { SpeechChunk, CallSession } from "../types/order.js";
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
import { formatTrackingChunkPhonetic } from "../utils/ttsFormatter.js";

export const USER_NOTEPAD_READY = "USER_NOTEPAD_READY";
export const TRACKING_DICTATION_COMPLETE = "TRACKING_DICTATION_COMPLETE";

/** Keep in sync with orderLookupProtocol.POST_INFORMATION_CLOSING_SPEECH — no import (circular dep). */
export const TRACKING_DICTATION_COMPLETE_SPEECH =
  "I have provided that, how else can I help you today?";

export const TRACKING_DICTATION_CONFIRM_SPEECH =
  "Did you write that correctly, or should I repeat it?";

const NOTEPAD_READY_RE =
  /\b(?:i'?m\s+ready|i am ready|we'?re ready|(?:have|got)\s+(?:it|my\s+(?:pen|notepad|paper))\s+ready|notepad\s+ready|pen\s+ready|go\s+ahead|all\s+set|you\s+can\s+go|have\s+my\s+pen|got\s+my\s+pen|paper\s+ready|pen\s+and\s+paper|\bready\b)/i;

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

export function buildNotepadReadyNudge(): string {
  return "Whenever you're ready with pen and notepad, just say ready and I'll read the tracking ID slowly.";
}

export function appendTrackingDictationConfirm(speech: string): string {
  const trimmed = speech.trim();
  if (!trimmed) return TRACKING_DICTATION_CONFIRM_SPEECH;
  if (/write that correctly|should I repeat/i.test(trimmed)) return trimmed;
  return `${trimmed} ${TRACKING_DICTATION_CONFIRM_SPEECH}`;
}

export function isAffirmativeUtterance(callerText: string): boolean {
  const text = callerText.trim();
  if (!text) return false;
  if (/^(yes|yeah|yep|yup|sure|ok|okay|please|go ahead)\.?$/i.test(text)) return true;
  return /^yes\b/i.test(text) && /\b(read|tracking|please)\b/i.test(text);
}

/** Caller accepted "Would you like me to read the tracking ID?" after order disclosure. */
export function isTrackingOfferAcceptance(callerText: string, session: CallSession): boolean {
  if (!session.awaitingTrackingOffer) return false;
  const text = callerText.trim();
  if (!text) return false;
  if (isAffirmativeUtterance(text)) return true;
  return /\b(read|tracking)\b/i.test(text) && /\b(yes|please|sure|ok|okay)\b/i.test(text);
}

export function isUserNotepadReadyIntent(callerText: string, callSid?: string): boolean {
  const text = callerText.trim();
  if (!text) return false;
  if (/\b(?:written|wrote|got it|thank|done writing|copied)\b/i.test(text)) return false;
  if (NOTEPAD_READY_RE.test(text)) return true;
  if (/^(yes|ok|okay)\.?$/i.test(text)) {
    if (!callSid) return false;
    const active = getOrCreateActiveSession(callSid);
    return active.currentState === "awaiting_notepad_ready";
  }
  return false;
}

/** Caller has tracking on file and has not finished dictation yet. */
export function isTrackingDictationPending(
  callSid: string,
  orderData?: Record<string, unknown>,
): boolean {
  const active = getOrCreateActiveSession(callSid);
  if (active.trackingDictationComplete) return false;
  const trackingRaw = String(orderData?.tracking_number ?? "").trim();
  return Boolean(active.lastSpokenPayload?.trackingForTts || trackingRaw);
}

/**
 * Begin tracking dictation after caller confirmed pen and notepad are ready.
 * Used by orchestrator and LLM intercepts so both paths share one handshake.
 */
export function beginTrackingDictationAfterNotepadReady(callSid: string): {
  ok: boolean;
  speech: string;
} {
  confirmUserNotepadReady(callSid);
  const dictated = dictateTracking(callSid);
  if (!dictated.ok) {
    return { ok: false, speech: dictated.error.message };
  }
  updateActiveSession(callSid, {
    currentState: "tracking_dictation",
    cachedIntent: "tracking",
    lastSpokenIndex: -1,
  });
  return { ok: true, speech: dictated.speech };
}

/** Start or repeat the pen-and-notepad handshake before digits are spoken. */
export function beginTrackingNotepadHandshake(callSid: string): string {
  markTrackingAwaitingNotepad(callSid);
  return promptUserForNotepad();
}

export function completeTrackingDictation(callSid: string): void {
  const active = getOrCreateActiveSession(callSid);
  updateActiveSession(callSid, {
    currentState: "order_active",
    awaitingClarification: null,
    cachedIntent: "order",
    lastSpokenIndex: -1,
    lastDictationIndex: -1,
    isNotepadReady: false,
    spatialIndex: [],
    trackingDictationComplete: true,
    lastSpokenPayload:
      active.lastSpokenPayload?.kind === "tracking"
        ? {
            kind: "order_status",
            speech: TRACKING_DICTATION_COMPLETE_SPEECH,
            intentKey: "tracking_complete",
            capturedAt: Date.now(),
          }
        : active.lastSpokenPayload,
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
        "I can help you with your tracking ID. Please tell me your order number first.",
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
    speech: appendTrackingDictationConfirm(trackingForTts),
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
  const active = getOrCreateActiveSession(callSid);
  if (active.currentState === "awaiting_notepad_ready" && active.lastSpokenPayload?.trackingForTts) {
    return;
  }
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
    const digitRun = slice.map((entry) => entry.digit).join("");
    const text =
      slice.length > 1
        ? formatTrackingChunkPhonetic(digitRun)
        : slice.map(entryToSpeech).join(" ");
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
