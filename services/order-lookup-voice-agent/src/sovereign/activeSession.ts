/**
 * Sovereign State Machine — single source of truth per call.
 */
import type { CallSession } from "../types/order.js";
import { formatTrackingNumberForTTS } from "../utils/ttsFormatter.js";
import type { LlmToolName } from "../adapters/llmToolExecutor.js";
import { getPreferredVoiceForCall } from "../adapters/voiceAdapter.js";

export type SovereignState =
  | "idle"
  | "order_active"
  | "catalog_active"
  | "cart_active"
  | "checkout_active"
  | "tracking_dictation"
  | "awaiting_notepad_ready"
  | "awaiting_clarification";

export interface SpatialIndexEntry {
  index: number;
  digit: string;
}

export interface LastSpokenPayload {
  kind: "tracking" | "order_status" | "catalog" | "cart" | "general";
  speech: string;
  trackingForTts?: string;
  trackingRaw?: string;
  toolName?: LlmToolName;
  intentKey?: string;
  capturedAt: number;
}

export interface ActiveSession {
  callSid: string;
  currentState: SovereignState;
  lastSpokenPayload: LastSpokenPayload | null;
  spatialIndex: SpatialIndexEntry[];
  awaitingClarification: string | null;
  cachedIntent: string | null;
  preferredVoice: "ElevenLabs" | "openai-tts-1-hd";
  /** Last spatial index spoken before an interrupt — resume from index + 1. */
  lastDictationIndex: number;
}

const store = new Map<string, ActiveSession>();

export function createActiveSession(callSid: string): ActiveSession {
  const session: ActiveSession = {
    callSid,
    currentState: "idle",
    lastSpokenPayload: null,
    spatialIndex: [],
    awaitingClarification: null,
    cachedIntent: null,
    preferredVoice: getPreferredVoiceForCall(callSid),
    lastDictationIndex: -1,
  };
  store.set(callSid, session);
  return session;
}

export function getActiveSession(callSid: string): ActiveSession | undefined {
  return store.get(callSid);
}

export function getOrCreateActiveSession(callSid: string): ActiveSession {
  return store.get(callSid) ?? createActiveSession(callSid);
}

export function updateActiveSession(
  callSid: string,
  patch: Partial<Omit<ActiveSession, "callSid">>,
): ActiveSession {
  const current = getOrCreateActiveSession(callSid);
  const next = { ...current, ...patch };
  store.set(callSid, next);
  return next;
}

export function clearActiveSession(callSid: string): void {
  store.delete(callSid);
}

export function recordDictationProgress(callSid: string, spokenIndex: number): ActiveSession {
  return updateActiveSession(callSid, { lastDictationIndex: spokenIndex });
}

export function buildSpatialResumeFromIndex(
  spatialIndex: SpatialIndexEntry[],
  startIndex: number,
): string | null {
  if (startIndex < 0 || startIndex >= spatialIndex.length) return null;
  const remaining = spatialIndex.slice(startIndex + 1);
  if (!remaining.length) return "That is the end of the tracking number.";
  return remaining.map((entry) => {
    const word =
      entry.digit >= "0" && entry.digit <= "9"
        ? ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"][
            Number(entry.digit)
          ]
        : entry.digit;
    return `${word}.`;
  }).join(" ");
}

export function buildSpatialIndexFromTracking(trackingId: string): SpatialIndexEntry[] {
  const normalized = trackingId.trim().toUpperCase();
  return [...normalized].map((digit, index) => ({ index, digit }));
}

export function recordTrackingPayload(
  callSid: string,
  trackingRaw: string,
  speech?: string,
): ActiveSession {
  const trackingForTts = formatTrackingNumberForTTS(trackingRaw);
  return updateActiveSession(callSid, {
    currentState: "awaiting_notepad_ready",
    awaitingClarification: "notepad_ready",
    spatialIndex: buildSpatialIndexFromTracking(trackingRaw),
    cachedIntent: "tracking",
    lastDictationIndex: -1,
    lastSpokenPayload: {
      kind: "tracking",
      speech: speech ?? trackingForTts,
      trackingForTts,
      trackingRaw,
      toolName: "get_shopify_order_status",
      intentKey: "tracking",
      capturedAt: Date.now(),
    },
  });
}

export function recordToolPayload(
  callSid: string,
  input: {
    kind: LastSpokenPayload["kind"];
    speech: string;
    toolName?: LlmToolName;
    intentKey: string;
    state: SovereignState;
    trackingRaw?: string;
  },
): ActiveSession {
  const trackingForTts = input.trackingRaw
    ? formatTrackingNumberForTTS(input.trackingRaw)
    : undefined;

  return updateActiveSession(callSid, {
    currentState: input.state,
    cachedIntent: input.intentKey,
    spatialIndex: input.trackingRaw
      ? buildSpatialIndexFromTracking(input.trackingRaw)
      : [],
    lastSpokenPayload: {
      kind: input.kind,
      speech: input.speech,
      toolName: input.toolName,
      intentKey: input.intentKey,
      trackingForTts,
      trackingRaw: input.trackingRaw,
      capturedAt: Date.now(),
    },
    awaitingClarification: null,
  });
}

export function shouldSkipToolReinvoke(
  active: ActiveSession,
  intentKey: string,
  toolName: LlmToolName,
): boolean {
  if (!active.lastSpokenPayload) return false;
  if (active.cachedIntent !== intentKey) return false;
  if (active.lastSpokenPayload.toolName !== toolName) return false;
  return active.currentState !== "idle" && active.currentState !== "awaiting_clarification";
}

export function syncActiveSessionFromCallSession(callSession: CallSession): ActiveSession {
  const active = getOrCreateActiveSession(callSession.callSid);

  if (callSession.shoppingCart?.length) {
    return updateActiveSession(callSession.callSid, {
      currentState: "cart_active",
      cachedIntent: "cart",
    });
  }

  if (callSession.pendingInvoiceUrl) {
    return updateActiveSession(callSession.callSid, {
      currentState: "checkout_active",
      cachedIntent: "checkout",
    });
  }

  if (callSession.currentOrderData && Object.keys(callSession.currentOrderData).length > 0) {
    const tracking = String(callSession.currentOrderData.tracking_number ?? "").trim();
    if (tracking) {
      return recordTrackingPayload(callSession.callSid, tracking);
    }
    return updateActiveSession(callSession.callSid, {
      currentState: "order_active",
      cachedIntent: "order",
    });
  }

  return active;
}

export function buildActiveSessionSystemMessage(active: ActiveSession): string {
  const lines = [
    "SOVEREIGN ACTIVE SESSION (MANDATORY — SINGLE SOURCE OF TRUTH)",
    `currentState: ${active.currentState}`,
    `cachedIntent: ${active.cachedIntent ?? "none"}`,
    `awaitingClarification: ${active.awaitingClarification ?? "none"}`,
  ];

  if (active.spatialIndex.length > 0) {
    lines.push(
      `spatialIndex: ${JSON.stringify(active.spatialIndex)}`,
      "For spatial resume questions (e.g. 'what comes after 3-9'), use spatialIndex — speak ONLY the digits after the latest anchor match.",
    );
  }

  if (active.lastSpokenPayload) {
    lines.push(
      `lastSpokenPayload.kind: ${active.lastSpokenPayload.kind}`,
      active.lastSpokenPayload.trackingForTts
        ? `tracking_number_for_tts (verbatim): ${active.lastSpokenPayload.trackingForTts}`
        : `lastSpoken: ${active.lastSpokenPayload.speech.slice(0, 200)}`,
    );
  }

  if (active.cachedIntent && active.currentState !== "idle") {
    lines.push(
      "TOOL RE-INVOCATION BAN: If the caller repeats the same intent already satisfied in ActiveSession, do NOT call tools again — retrieve from lastSpokenPayload.",
    );
  }

  return lines.join("\n");
}
