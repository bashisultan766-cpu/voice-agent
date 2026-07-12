/**
 * Unified Call Session — single source of truth for per-call brain + memory.
 *
 * Parallel Maps (ActiveSession, CallState, CallMemory, conversationFlowMode)
 * remain as thin adapters for legacy call sites, but authoritative workflow
 * fields live on CallSession and are kept in sync through this module.
 *
 * Persistence:
 *   L1 = sessionRegistry Map (hot path) — mid-turn mutations update L1 only
 *   L2 = Postgres call_sessions via sessionPersistence (restart / HA)
 *   L2 writes happen once per turn/tool boundary under withCallSessionLock
 *   (never fire-and-forget from touchUnifiedSession).
 */
import type { CallSession } from "../types/order.js";
import type { ConversationFlowMode } from "./conversationFlowState.js";
import type { ActiveWorkflowContext } from "./workflowContext.js";
import { logger } from "../utils/logger.js";
import {
  archivePersistedSessionAsync,
  isSessionPersistenceEnabled,
  loadPersistedSession,
  savePersistedSessionDetailed,
  type SessionPersistResult,
} from "../platform/sessionPersistence.js";
import { withCallSessionLock } from "../platform/sessionLock.js";

/** Sovereign surface mirrored onto CallSession to prevent Map desync. */
export type UnifiedSovereignState =
  | "idle"
  | "order_active"
  | "catalog_active"
  | "cart_active"
  | "checkout_active"
  | "tracking_dictation"
  | "awaiting_notepad_ready"
  | "awaiting_clarification";

export interface UnifiedSessionSlice {
  flowMode: ConversationFlowMode;
  sovereignState: UnifiedSovereignState;
  workflowContext: ActiveWorkflowContext;
}

export type UnifiedFlushResult = SessionPersistResult;

const sessionRegistry = new Map<string, CallSession>();
/** CallSids with L1 mutations pending a locked L2 flush. */
const dirtySessions = new Set<string>();

function markSessionDirty(callSid: string): void {
  if (callSid) dirtySessions.add(callSid);
}

function clearSessionDirty(callSid: string): void {
  dirtySessions.delete(callSid);
}

export function isUnifiedSessionDirty(callSid: string): boolean {
  return dirtySessions.has(callSid);
}

export function registerUnifiedSession(session: CallSession): CallSession {
  ensureUnifiedDefaults(session);
  sessionRegistry.set(session.callSid, session);
  markSessionDirty(session.callSid);
  if (isSessionPersistenceEnabled()) {
    // Session create is a critical boundary — one locked flush (async, non-blocking).
    void flushUnifiedSessionToL2(session).catch(() => undefined);
  } else {
    clearSessionDirty(session.callSid);
  }
  return session;
}

export function getUnifiedSession(callSid: string): CallSession | undefined {
  return sessionRegistry.get(callSid);
}

/**
 * L1 hit, else L2 hydrate from Postgres into the registry.
 * Use on Twilio WS setup / reconnect so restarts do not drop live calls.
 */
export async function getOrHydrateUnifiedSession(
  callSid: string,
): Promise<CallSession | undefined> {
  const cached = sessionRegistry.get(callSid);
  if (cached) return cached;

  return withCallSessionLock(callSid, async () => {
    const again = sessionRegistry.get(callSid);
    if (again) return again;

    const record = await loadPersistedSession(callSid);
    if (!record) return undefined;

    ensureUnifiedDefaults(record.session);
    sessionRegistry.set(callSid, record.session);
    clearSessionDirty(callSid);
    logger.info("unified_session_hydrated", {
      callSid: callSid.slice(0, 8),
      version: record.version,
      phase: record.session.phase,
      flowMode: record.session.flowMode,
    });
    return record.session;
  });
}

/**
 * Mid-turn L1 update only — does NOT write Postgres.
 * Call flushUnifiedSessionToL2 at end-of-turn or a critical tool boundary.
 */
export function touchUnifiedSession(session: CallSession): void {
  ensureUnifiedDefaults(session);
  sessionRegistry.set(session.callSid, session);
  markSessionDirty(session.callSid);
}

/**
 * Single locked L2 flush for the call. Coalesces mid-turn L1 mutations into one upsert.
 * Safe to call when persistence is disabled (returns ok/skipped).
 */
export async function flushUnifiedSessionToL2(
  session: CallSession,
  options?: { force?: boolean },
): Promise<UnifiedFlushResult> {
  ensureUnifiedDefaults(session);
  sessionRegistry.set(session.callSid, session);

  if (!isSessionPersistenceEnabled()) {
    clearSessionDirty(session.callSid);
    return { ok: true, version: null, skipped: true };
  }

  if (!options?.force && !dirtySessions.has(session.callSid)) {
    return { ok: true, version: session.persistenceVersion ?? null, skipped: true };
  }

  return withCallSessionLock(session.callSid, async () => {
    if (!options?.force && !dirtySessions.has(session.callSid)) {
      return { ok: true, version: session.persistenceVersion ?? null, skipped: true };
    }

    const result = await savePersistedSessionDetailed(session);
    if (result.ok) {
      clearSessionDirty(session.callSid);
    } else {
      logger.warn("unified_session_flush_failed", {
        callSid: session.callSid.slice(0, 8),
        reason: result.reason,
      });
    }
    return result;
  });
}

export function unregisterUnifiedSession(callSid: string): void {
  const session = sessionRegistry.get(callSid);
  sessionRegistry.delete(callSid);
  clearSessionDirty(callSid);
  archivePersistedSessionAsync(callSid, session);
}

export function clearAllUnifiedSessions(): void {
  sessionRegistry.clear();
  dirtySessions.clear();
}

export function ensureUnifiedDefaults(session: CallSession): void {
  if (!session.flowMode) session.flowMode = "idle";
  if (!session.sovereignState) session.sovereignState = "idle";
  if (!session.activeWorkflowContext) session.activeWorkflowContext = "idle";
  if (!session.sessionMemory) {
    session.sessionMemory = { initialIntent: null, pendingGoal: null };
  }
}

/**
 * Derive a consistent sovereign state from CallSession fields.
 * Catalog / purchase context wins over stale order_active when shopping.
 */
export function deriveSovereignState(session: CallSession): UnifiedSovereignState {
  const tracking =
    session.sovereignState === "tracking_dictation" ||
    session.sovereignState === "awaiting_notepad_ready";
  if (tracking) return session.sovereignState!;

  if ((session.shoppingCart?.length ?? 0) > 0) return "cart_active";
  if (session.pendingInvoiceUrl) return "checkout_active";

  if (
    session.flowMode === "PURCHASE_FLOW" ||
    session.activeWorkflowContext === "product_search" ||
    session.lastOrchestratorIntent === "catalog" ||
    session.lastOrchestratorIntent === "product_search" ||
    (session.awaitingInput?.startsWith("product_") ?? false)
  ) {
    return "catalog_active";
  }

  if (session.orderContextConfirmed && session.currentOrderData) {
    return "order_active";
  }

  if (
    session.awaitingInput === "order_number" ||
    session.phase === "awaiting_order_number" ||
    session.lastOrchestratorIntent === "order_lookup"
  ) {
    return "order_active";
  }

  return "idle";
}

/**
 * Clean Order Lookup ↔ Product Search transition without fallback loops.
 * Clears conflicting awaiting slots and aligns flowMode + sovereign + workflow.
 */
export function applyUnifiedWorkflowTransition(
  session: CallSession,
  target: "product_search" | "order_lookup" | "idle",
  options?: { reason?: string },
): UnifiedSessionSlice {
  ensureUnifiedDefaults(session);

  if (target === "product_search") {
    session.flowMode = "PURCHASE_FLOW";
    session.activeWorkflowContext = "product_search";
    session.lastOrchestratorIntent = "catalog";
    if (session.awaitingInput === "order_number") {
      session.awaitingInput = null;
    }
    if (session.phase === "awaiting_order_number") {
      session.phase = "follow_up";
    }
    session.sovereignState = "catalog_active";
  } else if (target === "order_lookup") {
    session.flowMode = "SUPPORT_FLOW";
    session.activeWorkflowContext = "order_lookup";
    session.lastOrchestratorIntent = "order_lookup";
    if (session.awaitingInput?.startsWith("product_")) {
      session.awaitingInput = "order_number";
    }
    if (
      session.sovereignState === "catalog_active" ||
      session.sovereignState === "cart_active"
    ) {
      session.sovereignState = session.orderContextConfirmed ? "order_active" : "idle";
    }
  } else {
    session.flowMode = "idle";
    session.activeWorkflowContext = "idle";
    session.sovereignState = deriveSovereignState(session);
  }

  const slice: UnifiedSessionSlice = {
    flowMode: session.flowMode,
    sovereignState: session.sovereignState ?? "idle",
    workflowContext: session.activeWorkflowContext ?? "idle",
  };

  logger.info("unified_workflow_transition", {
    callSid: session.callSid.slice(0, 8),
    target,
    reason: options?.reason ?? "unspecified",
    ...slice,
  });

  touchUnifiedSession(session);
  return slice;
}

/** Project CallSession unified fields into the legacy ActiveSession Map shape. */
export function projectUnifiedOntoSession(session: CallSession): UnifiedSessionSlice {
  ensureUnifiedDefaults(session);
  session.sovereignState = deriveSovereignState(session);
  return {
    flowMode: session.flowMode ?? "idle",
    sovereignState: session.sovereignState,
    workflowContext: session.activeWorkflowContext ?? "idle",
  };
}

/**
 * Atomic mutation helper — holds the per-call mutex, runs work, then one L2 flush.
 * Use for any multi-step session write that must not interleave with another frame.
 */
export async function mutateUnifiedSession<T>(
  session: CallSession,
  work: (session: CallSession) => Promise<T> | T,
): Promise<T> {
  return withCallSessionLock(session.callSid, async () => {
    const result = await work(session);
    ensureUnifiedDefaults(session);
    sessionRegistry.set(session.callSid, session);
    markSessionDirty(session.callSid);

    if (isSessionPersistenceEnabled()) {
      const flush = await savePersistedSessionDetailed(session);
      if (flush.ok) {
        clearSessionDirty(session.callSid);
      } else {
        logger.warn("unified_session_mutate_flush_failed", {
          callSid: session.callSid.slice(0, 8),
          reason: flush.reason,
        });
      }
    } else {
      clearSessionDirty(session.callSid);
    }

    return result;
  });
}
