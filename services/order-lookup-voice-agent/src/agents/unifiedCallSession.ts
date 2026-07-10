/**
 * Unified Call Session — single source of truth for per-call brain + memory.
 *
 * Parallel Maps (ActiveSession, CallState, CallMemory, conversationFlowMode)
 * remain as thin adapters for legacy call sites, but authoritative workflow
 * fields live on CallSession and are kept in sync through this module.
 */
import type { CallSession } from "../types/order.js";
import type { ConversationFlowMode } from "./conversationFlowState.js";
import type { ActiveWorkflowContext } from "./workflowContext.js";
import { logger } from "../utils/logger.js";

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

const sessionRegistry = new Map<string, CallSession>();

export function registerUnifiedSession(session: CallSession): CallSession {
  ensureUnifiedDefaults(session);
  sessionRegistry.set(session.callSid, session);
  return session;
}

export function getUnifiedSession(callSid: string): CallSession | undefined {
  return sessionRegistry.get(callSid);
}

export function unregisterUnifiedSession(callSid: string): void {
  sessionRegistry.delete(callSid);
}

export function clearAllUnifiedSessions(): void {
  sessionRegistry.clear();
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
