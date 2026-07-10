/**
 * Central Agent Brain — sole authority for workflow ownership, cancellation, and session memory.
 * All workflow transitions and tool gating should consult this module.
 */
import type { CallSession } from "../types/order.js";
import { logger } from "../utils/logger.js";
import {
  addToCart,
  getCartSummary,
  setCartLineQuantity,
} from "./cartManager.js";
import {
  isCatalogShoppingUtterance,
  isCartActionUtterance,
  parseCartQuantityFromSpeech,
} from "./catalogShoppingIntent.js";
import { isPurchaseFlowActive, setConversationFlowMode } from "./conversationFlowState.js";
import {
  cancelSupportEscalation,
  isSupportEscalationActive,
} from "./supportEscalationFlow.js";
import { syncActiveWorkflowContext } from "./workflowContext.js";
import { captureSessionIntent, getSessionMemory, type BufferedSessionIntent } from "./sessionMemory.js";
import { isSupportEscalationRequest, type CallerIntent } from "./callerIntent.js";
import { isEmailConfirmationActive } from "./emailConfirmationManager.js";
import { shouldAbortEmailConfirmation, isOrderContextSwitchUtterance } from "../utils/emailCapture.js";

export type AgentWorkflow =
  | "idle"
  | "email_confirmation"
  | "payment_checkout"
  | "cart_checkout"
  | "product_search"
  | "support_escalation"
  | "order_lookup"
  | "order_detail"
  | "order_history"
  | "tracking"
  | "general_help";

export interface BrainControlResult {
  cancelledSupport: boolean;
  deterministicCartSpeech?: string;
  activeWorkflow: AgentWorkflow;
}

/** User explicitly cancels or overrides a stale support escalation. */
export function isWorkflowCancellationUtterance(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (shouldAbortEmailConfirmation(t)) return true;
  const lower = t.toLowerCase();
  return (
    /\b(no.{0,30}(?:don'?t|do not)\s+(?:send|want|need).{0,30}support)\b/i.test(lower) ||
    /\b(don'?t\s+want\s+support|forget\s+support|cancel\s+(?:that|this|support)|stop\s+that)\b/i.test(lower) ||
    /\b(i\s+want\s+to\s+buy|add\s+\d+\s+cop|add\s+(?:twenty|ten|five)\s+cop)/i.test(t)
  );
}

/**
 * When true, defer regex/deterministic order-field speech to the LLM (single-brain routing).
 * Safety gates (email capture, notepad, privacy refusal) still run first.
 */
export function shouldPreferLlmPrimaryRouting(
  session: CallSession,
  text: string,
  callerIntent: CallerIntent,
): boolean {
  if (!session.orderContextConfirmed || !session.currentOrderData) return false;
  if (isEmailConfirmationActive(session)) return false;
  if (shouldAbortEmailConfirmation(text) || isWorkflowCancellationUtterance(text)) return true;
  if (isOrderContextSwitchUtterance(text)) return true;
  return (
    callerIntent === "order_field_query" ||
    callerIntent === "general_help" ||
    callerIntent === "neutral_listen"
  );
}

export function resolveAgentWorkflow(session: CallSession): AgentWorkflow {
  syncActiveWorkflowContext(session);
  const ctx = session.activeWorkflowContext;
  if (ctx === "email_confirmation") return "email_confirmation";
  if (ctx === "payment_checkout") return "payment_checkout";
  if (ctx === "support_escalation") return "support_escalation";
  if ((session.shoppingCart?.length ?? 0) > 0) return "cart_checkout";
  if (ctx === "product_search") return "product_search";
  if (ctx === "order_lookup") return "order_lookup";
  if (session.orderContextConfirmed && session.currentOrderData) return "order_detail";
  return "idle";
}

export function syncBrainMemory(
  session: CallSession,
  text: string,
  callerIntent: CallerIntent,
): void {
  const memory = getSessionMemory(session);
  memory.lastUserRequest = text.trim();
  memory.currentIntent = callerIntent;
  memory.activeWorkflow = resolveAgentWorkflow(session);

  const qty = parseCartQuantityFromSpeech(text);
  if (qty != null) {
    memory.latestQuantityRequested = qty;
  }

  const target = session.lastCatalogSearch;
  if (target?.variantId) {
    memory.lastProductTitle = target.title;
    memory.lastProductId = target.variantId;
    memory.lastProductPrice = target.unitPrice;
    memory.lastProductIsbn = target.isbn;
  }

  if (session.currentOrderData?.order_number) {
    memory.lastOrderNumber = String(session.currentOrderData.order_number).replace(/^#/, "");
  }
  memory.verificationStatus = session.isVerifiedCaller === true ? "verified" : "non_verified";
  memory.supportEscalationStatus = session.supportEscalation?.state ?? "normal";
  memory.emailConfirmationStatus = session.emailConfirmation?.phase ?? "idle";
  memory.paymentLinkStatus = session.paymentLinkSent ? "sent" : "pending";
}

/**
 * Cancel stale support escalation when the caller pivots to product/cart or says stop.
 */
export function applyBrainWorkflowControl(
  session: CallSession,
  text: string,
  callerIntent: CallerIntent,
): BrainControlResult {
  syncBrainMemory(session, text, callerIntent);
  captureSessionIntent(session, text, callerIntent);

  let cancelledSupport = false;
  const pivotToPurchase =
    callerIntent === "catalog" ||
    callerIntent === "cart" ||
    isCartActionUtterance(text) ||
    isCatalogShoppingUtterance(text);

  if (
    isSupportEscalationActive(session) &&
    (isWorkflowCancellationUtterance(text) || pivotToPurchase)
  ) {
    cancelSupportEscalation(session);
    cancelledSupport = true;
    if (pivotToPurchase) {
      setConversationFlowMode(session.callSid, "PURCHASE_FLOW");
    }
    logger.info("support_escalation_cancelled_by_user", {
      callSid: session.callSid.slice(0, 8),
      pivotIntent: callerIntent,
    });
  }

  const cartTurn = tryDeterministicCartTurn(session, text);
  syncBrainMemory(session, text, callerIntent);

  return {
    cancelledSupport,
    deterministicCartSpeech: cartTurn?.speech,
    activeWorkflow: resolveAgentWorkflow(session),
  };
}

/** True when support escalation turn should be skipped for product/cart flows. */
export function shouldSuppressSupportEscalation(
  session: CallSession,
  text: string,
  callerIntent: CallerIntent,
): boolean {
  if (isSupportEscalationRequest(text)) return false;
  if (isWorkflowCancellationUtterance(text)) return true;
  if (callerIntent === "catalog" || callerIntent === "cart") return true;
  if (isCartActionUtterance(text) && (session.lastCatalogSearch?.variantId || getCartSummary(session).lineCount > 0)) {
    return true;
  }
  if (isPurchaseFlowActive(session.callSid) && !/\b(support|forward\s+(?:it|to)|human|agent|representative)\b/i.test(text)) {
    return true;
  }
  return false;
}

/** True when LLM should not auto-escalate on catalog miss/OOS — cart or last product is active. */
export function shouldSuppressCatalogEscalation(session?: CallSession): boolean {
  if (!session) return false;
  if ((session.shoppingCart?.length ?? 0) > 0) return true;
  if (session.lastCatalogSearch?.variantId) return true;
  if (isPurchaseFlowActive(session.callSid)) return true;
  return false;
}

function isAbsoluteQuantityChange(text: string): boolean {
  return /\b(?:make\s+it|change\s+(?:it\s+)?to|set\s+(?:it\s+)?to|no,?\s+make\s+it)\b/i.test(text);
}

/**
 * Deterministic cart update for "Add 20 copies" / "Make it 10" using last catalog target.
 */
export function tryDeterministicCartTurn(
  session: CallSession,
  text: string,
): { handled: true; speech: string } | null {
  if (!isCartActionUtterance(text)) return null;

  const target = session.lastCatalogSearch;
  const qty = parseCartQuantityFromSpeech(text);
  if (!target?.variantId || qty == null || qty <= 0) return null;

  const lineInput = {
    variant_id: target.variantId,
    title: target.title,
    unit_price: target.unitPrice,
    isbn: target.isbn,
  };

  if (isAbsoluteQuantityChange(text)) {
    setCartLineQuantity(session, lineInput, qty);
  } else {
    const existing = session.shoppingCart?.find((l) => l.variantId === target.variantId);
    if (existing) {
      setCartLineQuantity(session, lineInput, existing.quantity + qty);
    } else {
      addToCart(session, [{ ...lineInput, quantity: qty }]);
    }
  }

  const memory = getSessionMemory(session);
  memory.latestQuantityRequested = qty;
  memory.unresolvedUserGoal = null;
  session.lastOrchestratorIntent = "cart";
  setConversationFlowMode(session.callSid, "PURCHASE_FLOW");

  const summary = getCartSummary(session);
  const line = summary.items.find((l) => l.variantId === target.variantId);
  const count = line?.quantity ?? qty;
  const title = target.title || "that book";
  return {
    handled: true,
    speech: `I've updated your cart to ${count} ${count === 1 ? "copy" : "copies"} of ${title}.`,
  };
}

export function mapCallerIntentToBuffered(intent: CallerIntent): BufferedSessionIntent | null {
  if (intent === "order_lookup" || intent === "tracking_dictation" || intent === "tracking_flow_active") {
    return intent === "tracking_dictation" || intent === "tracking_flow_active" ? "tracking_id" : "order_lookup";
  }
  return null;
}
