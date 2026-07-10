/**
 * Central intent router — strict workflow priority ownership.
 *
 * DEPRECATED as a competing semantic brain (Architectural Audit Priority 6).
 * Ownership locks (email / payment / cart) remain; utterance classification
 * is LLM-primary via agentBrain.shouldPreferLlmPrimaryRouting + OpenAI tools.
 * Do not add new regex intercepts here — extend the LLM tool surface instead.
 *
 * Priority order (locks only):
 * 1. Email Confirmation
 * 2. Payment Checkout
 * 3. Shopping Cart
 * 4. Product Search
 * 5. Support Escalation
 * 6. Order History
 * 7. Order Detail
 * 8. Tracking
 * 9. General Help
 */
import type { CallSession } from "../types/order.js";
import { isEmailConfirmationLocked } from "./emailConfirmationManager.js";
import { isSupportEscalationActive } from "./supportEscalationFlow.js";
import { isPaymentCheckoutLocked } from "./paymentCheckoutFlow.js";
import { getCartSummary } from "./cartManager.js";
import { isOrderHistoryContextActive } from "./orderHistoryFlow.js";
import { isOrderFieldQuestion } from "./orderFollowUpSpeech.js";
import { isCatalogShoppingUtterance } from "./catalogShoppingIntent.js";
import { getOrCreateActiveSession } from "../sovereign/activeSession.js";
import { isTrackingDictationPending } from "./dictationTool.js";
import {
  isProductSearchContextActive,
  isOrderLookupContextActive,
} from "./workflowContext.js";

export enum WorkflowPriority {
  EmailConfirmation = 1,
  SupportEscalation = 2,
  PaymentCheckout = 3,
  ShoppingCart = 4,
  OrderHistory = 5,
  OrderDetail = 6,
  ProductSearch = 7,
  Tracking = 8,
  GeneralHelp = 9,
}

export function resolveActiveWorkflowPriority(session: CallSession): WorkflowPriority {
  if (isEmailConfirmationLocked(session)) return WorkflowPriority.EmailConfirmation;
  if (isPaymentCheckoutLocked(session)) return WorkflowPriority.PaymentCheckout;
  if ((session.shoppingCart?.length ?? 0) > 0) return WorkflowPriority.ShoppingCart;
  if (isProductSearchContextActive(session)) return WorkflowPriority.ProductSearch;
  if (isSupportEscalationActive(session)) return WorkflowPriority.SupportEscalation;
  if (isOrderHistoryContextActive(session)) return WorkflowPriority.OrderHistory;
  if (isOrderLookupContextActive(session)) return WorkflowPriority.OrderDetail;
  if (hasActiveOrderContext(session)) return WorkflowPriority.OrderDetail;
  return WorkflowPriority.GeneralHelp;
}

function hasActiveOrderContext(session: CallSession): boolean {
  return session.orderContextConfirmed === true && Boolean(session.currentOrderData);
}

export function isWorkflowBlocked(
  session: CallSession,
  attempted: WorkflowPriority,
): boolean {
  const active = resolveActiveWorkflowPriority(session);
  return attempted > active;
}

export function shouldDeferToHigherPriorityWorkflow(
  session: CallSession,
  callerText: string,
): WorkflowPriority | null {
  const active = resolveActiveWorkflowPriority(session);
  const text = callerText.trim();
  if (!text) return null;

  if (active === WorkflowPriority.EmailConfirmation) {
    return WorkflowPriority.EmailConfirmation;
  }

  if (active === WorkflowPriority.SupportEscalation) {
    if (/\b(tracking|order history|buy|checkout|isbn)\b/i.test(text)) {
      return WorkflowPriority.SupportEscalation;
    }
  }

  if (active === WorkflowPriority.PaymentCheckout) {
    return WorkflowPriority.PaymentCheckout;
  }

  const callSid = session.callSid;
  // Prefer unified sovereign surface; fall back to ActiveSession Map adapter.
  const sovereignState = session.sovereignState;
  const sovereign = getOrCreateActiveSession(callSid);
  const inTracking =
    sovereignState === "tracking_dictation" ||
    sovereignState === "awaiting_notepad_ready" ||
    sovereign.currentState === "tracking_dictation" ||
    (sovereign.currentState === "awaiting_notepad_ready" && sovereign.cachedIntent === "tracking") ||
    isTrackingDictationPending(callSid, session.currentOrderData);

  if (inTracking && active <= WorkflowPriority.Tracking) {
    if (isOrderFieldQuestion(text, session) || isCatalogShoppingUtterance(text)) {
      return WorkflowPriority.Tracking;
    }
  }

  if (isEmailConfirmationLocked(session)) return WorkflowPriority.EmailConfirmation;
  if (isSupportEscalationActive(session)) return WorkflowPriority.SupportEscalation;

  const cartActive = (getCartSummary(session).lineCount ?? 0) > 0;
  if (cartActive && /\b(checkout|payment link|pay now)\b/i.test(text)) {
    return WorkflowPriority.PaymentCheckout;
  }

  return null;
}
