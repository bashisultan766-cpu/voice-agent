/**
 * SessionStateService — sticky order-lookup gate + durable ActiveSession
 * dictation metadata (tracking / notepad / spatial index) for restart survival.
 *
 * Architecture:
 *   L1 ActiveSession Map  — hot path
 *   L1 CallSession.sessionMemory.metadata — mirrored on every ActiveSession write
 *   L2 Postgres call_sessions.session_json — async flush via flushUnifiedSessionToL2
 *
 * Restart-while-speaking race:
 *   Mid-utterance audio is lost with the dying process (transport gap).
 *   We persist a durable dictation *cursor* (tracking_number_for_tts, spatial_index,
 *   lastSpokenIndex, is_tracking_in_progress). On reconnect, createOrHydrateCallSession
 *   awaits hydrateSessionMemory under withCallSessionLock before any VAD turn runs.
 *   Resume continues from the last flushed cursor — not mid-phoneme.
 */
import type { CallSession } from "../types/order.js";
import { getActiveOrderContext } from "./sessionManager.js";
import { orderNumbersMatch } from "../utils/formatter.js";
import { normalizeOrderNumber } from "../utils/inputNormalizer.js";
import {
  ensureSessionMemory,
  type SessionDictationMetadata,
} from "./sessionMemory.js";
import {
  createActiveSession,
  getActiveSession,
  getOrCreateActiveSession,
  updateActiveSession,
  type ActiveSession,
  type LastSpokenDataPoint,
  type LastSpokenPayload,
  type SovereignState,
  type SpatialIndexEntry,
} from "../sovereign/activeSession.js";
import {
  flushUnifiedSessionToL2,
  getUnifiedSession,
  touchUnifiedSession,
} from "./unifiedCallSession.js";
import { withCallSessionLock } from "../platform/sessionLock.js";
import { logger } from "../utils/logger.js";
import type { LlmToolName } from "../adapters/llmToolExecutor.js";

/** In-flight hydration promises — first VAD turn awaits the same barrier. */
const hydrationBarriers = new Map<string, Promise<ActiveSession>>();

export function getStickyOrderNumber(session?: CallSession): string | undefined {
  if (!session) return undefined;
  return (
    session.currentSessionOrder?.orderNumber ??
    session.sessionOrderContext?.orderNumber ??
    getActiveOrderContext(session)?.order_number ??
    session.currentOrder?.orderNumber
  );
}

export function isOrderLookupComplete(session?: CallSession): boolean {
  if (!session) return false;
  if (session.orderLookupComplete) return true;
  if (session.currentSessionOrder?.orderNumber) return true;
  return Boolean(getStickyOrderNumber(session) && session.orderContextConfirmed);
}

/**
 * Single sticky re-invoke gate — replace all parallel shouldBlock* checks.
 * Returns true when the agent must reuse cached order context instead of Shopify.
 */
export function shouldBlockOrderLookupReinvoke(
  session: CallSession | undefined,
  requestedOrderNumber?: string,
): boolean {
  if (!session || !isOrderLookupComplete(session)) return false;
  const sticky = getStickyOrderNumber(session);
  if (!sticky) return false;

  const requested = (requestedOrderNumber ?? "").trim();
  if (!requested) return true;

  const normalizedRequested = normalizeOrderNumber(requested) || requested;
  return orderNumbersMatch(sticky, normalizedRequested) || orderNumbersMatch(sticky, requested);
}

/** Persist sticky order SSOT after a successful lookup. */
export function markOrderLookupSticky(
  session: CallSession,
  orderNumber: string,
  extras?: {
    customerName?: string;
    fulfillmentStatus?: string;
    financialStatus?: string;
  },
): void {
  session.orderLookupComplete = true;
  session.orderContextConfirmed = true;
  session.currentSessionOrder = {
    orderNumber,
    customerName: extras?.customerName,
    fulfillmentStatus: extras?.fulfillmentStatus,
    financialStatus: extras?.financialStatus,
  };
}

function isTrackingInProgress(active: ActiveSession): boolean {
  if (active.trackingDictationComplete) return false;
  if (active.cachedIntent !== "tracking" && active.currentState !== "tracking_dictation") {
    return false;
  }
  return (
    active.currentState === "tracking_dictation" ||
    active.currentState === "awaiting_notepad_ready" ||
    Boolean(active.lastSpokenPayload?.trackingForTts) ||
    active.spatialIndex.length > 0
  );
}

/** Build durable metadata blob from the live ActiveSession Map. */
export function buildDictationMetadata(active: ActiveSession): SessionDictationMetadata {
  const trackingRaw =
    active.lastSpokenPayload?.trackingRaw ??
    active.lastSpokenDataPoint?.raw ??
    undefined;
  const trackingForTts =
    active.lastSpokenPayload?.trackingForTts ??
    active.lastSpokenDataPoint?.forTts ??
    undefined;

  return {
    tracking_number: trackingRaw,
    tracking_number_for_tts: trackingForTts,
    notepad_content: active.isNotepadReady ? "ready" : active.awaitingClarification ?? "",
    spatial_index: active.spatialIndex.map((e) => ({ index: e.index, digit: e.digit })),
    last_spoken_index: active.lastSpokenIndex,
    last_dictation_index: active.lastDictationIndex,
    is_tracking_in_progress: isTrackingInProgress(active),
    is_notepad_ready: active.isNotepadReady,
    tracking_dictation_complete: active.trackingDictationComplete,
    current_state: active.currentState,
    cached_intent: active.cachedIntent,
    awaiting_clarification: active.awaitingClarification,
    last_spoken_payload: active.lastSpokenPayload
      ? { ...active.lastSpokenPayload }
      : null,
    last_spoken_data_point: active.lastSpokenDataPoint
      ? { ...active.lastSpokenDataPoint }
      : null,
    updated_at: Date.now(),
  };
}

/**
 * Mirror ActiveSession → sessionMemory.metadata and schedule a non-blocking L2 flush.
 * Idempotent: same metadata_version + payload is a no-op skip on flush dirty flag.
 */
export function syncSessionMemory(
  callSid: string,
  data?: Partial<SessionDictationMetadata>,
): void {
  const session = getUnifiedSession(callSid);
  if (!session) return;

  const active = getActiveSession(callSid) ?? getOrCreateActiveSession(callSid);
  const memory = ensureSessionMemory(session);
  const prevVersion = memory.metadata?.metadata_version ?? 0;
  const next: SessionDictationMetadata = {
    ...buildDictationMetadata(active),
    ...data,
    metadata_version: prevVersion + 1,
    updated_at: Date.now(),
  };
  memory.metadata = next;

  // Keep CallSession sovereign surface aligned for L2 snapshots.
  if (next.current_state) {
    session.sovereignState = next.current_state as CallSession["sovereignState"];
  }

  touchUnifiedSession(session);
  void flushUnifiedSessionToL2(session).catch((err) => {
    logger.warn("session_memory_sync_flush_failed", {
      callSid: callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

function recoveredKeys(meta: SessionDictationMetadata): string[] {
  return Object.entries(meta)
    .filter(([key, value]) => {
      if (key === "metadata_version" || key === "updated_at") return false;
      if (value == null) return false;
      if (typeof value === "string" && value.length === 0) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    })
    .map(([key]) => key);
}

/**
 * Populate the ActiveSession Map from durable sessionMemory.metadata.
 * Empty / missing metadata → empty ActiveSession (initialized defaults).
 * Must run under withCallSessionLock (createOrHydrateCallSession / barrier).
 */
export function hydrateSessionMemory(
  callSid: string,
  session?: CallSession | null,
): ActiveSession {
  const live = session ?? getUnifiedSession(callSid);
  const meta = live?.sessionMemory?.metadata;

  if (!meta || Object.keys(meta).length === 0) {
    logger.info(
      `[SessionHydration] callSid=${callSid} recoveredState=`,
      { callSid: callSid.slice(0, 8), recoveredState: [] },
    );
    return getActiveSession(callSid) ?? createActiveSession(callSid);
  }

  const keys = recoveredKeys(meta);
  const spatialIndex: SpatialIndexEntry[] = Array.isArray(meta.spatial_index)
    ? meta.spatial_index.map((e) => ({ index: e.index, digit: e.digit }))
    : [];

  const payload = meta.last_spoken_payload
    ? ({
        ...meta.last_spoken_payload,
        toolName: meta.last_spoken_payload.toolName as LlmToolName | undefined,
      } as LastSpokenPayload)
    : meta.tracking_number_for_tts
      ? ({
          kind: "tracking",
          speech: meta.tracking_number_for_tts,
          trackingForTts: meta.tracking_number_for_tts,
          trackingRaw: meta.tracking_number,
          intentKey: "tracking",
          capturedAt: meta.updated_at ?? Date.now(),
        } satisfies LastSpokenPayload)
      : null;

  const dataPoint: LastSpokenDataPoint | null = meta.last_spoken_data_point
    ? { ...meta.last_spoken_data_point }
    : meta.tracking_number
      ? {
          kind: "tracking_number",
          raw: meta.tracking_number,
          forTts: meta.tracking_number_for_tts ?? meta.tracking_number,
          capturedAt: meta.updated_at ?? Date.now(),
        }
      : null;

  const currentState = (meta.current_state as SovereignState | undefined) ??
    (meta.is_tracking_in_progress
      ? meta.is_notepad_ready
        ? "tracking_dictation"
        : "awaiting_notepad_ready"
      : "idle");

  const active = updateActiveSession(
    callSid,
    {
      currentState,
      cachedIntent: meta.cached_intent ?? (meta.is_tracking_in_progress ? "tracking" : null),
      awaitingClarification: meta.awaiting_clarification ?? null,
      spatialIndex,
      lastSpokenIndex: meta.last_spoken_index ?? -1,
      lastDictationIndex: meta.last_dictation_index ?? -1,
      isNotepadReady: Boolean(meta.is_notepad_ready),
      trackingDictationComplete: Boolean(meta.tracking_dictation_complete),
      lastSpokenPayload: payload,
      lastSpokenDataPoint: dataPoint,
    },
    { persist: false },
  );

  if (live && meta.is_tracking_in_progress) {
    live.sovereignState = active.currentState;
  }

  logger.info(
    `[SessionHydration] callSid=${callSid} recoveredState=${keys.join(",")}`,
    {
      callSid: callSid.slice(0, 8),
      recoveredState: keys,
      is_tracking_in_progress: Boolean(meta.is_tracking_in_progress),
      lastSpokenIndex: active.lastSpokenIndex,
      currentState: active.currentState,
    },
  );

  return active;
}

/**
 * Awaitable hydration barrier — reconnect / startup must finish before VAD turns.
 * Concurrent callers share one in-flight promise (idempotent).
 */
export async function ensureSessionMemoryHydrated(
  callSid: string,
  session?: CallSession | null,
): Promise<ActiveSession> {
  const existing = hydrationBarriers.get(callSid);
  if (existing) return existing;

  const work = withCallSessionLock(callSid, () =>
    hydrateSessionMemory(callSid, session ?? getUnifiedSession(callSid)),
  ).finally(() => {
    hydrationBarriers.delete(callSid);
  });

  hydrationBarriers.set(callSid, work);
  return work;
}

export function clearSessionHydrationBarrier(callSid: string): void {
  hydrationBarriers.delete(callSid);
}

export const SessionStateService = {
  getStickyOrderNumber,
  isOrderLookupComplete,
  shouldBlockOrderLookupReinvoke,
  markOrderLookupSticky,
  syncSessionMemory,
  hydrateSessionMemory,
  ensureSessionMemoryHydrated,
  buildDictationMetadata,
} as const;
