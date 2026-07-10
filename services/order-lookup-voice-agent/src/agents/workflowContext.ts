/**
 * Active workflow context — numeric utterances route to ISBN vs order number.
 * Reads unified CallSession.flowMode first to avoid Map desync.
 */
import type { CallSession } from "../types/order.js";
import { isPurchaseFlowActive } from "./conversationFlowState.js";
import { isEmailConfirmationLocked } from "./emailConfirmationManager.js";
import { isPaymentCheckoutLocked } from "./paymentCheckoutFlow.js";
import { isSupportEscalationActive } from "./supportEscalationFlow.js";

export type ActiveWorkflowContext =
  | "idle"
  | "email_confirmation"
  | "support_escalation"
  | "payment_checkout"
  | "product_search"
  | "order_lookup";

export function resolveActiveWorkflowContext(session: CallSession): ActiveWorkflowContext {
  if (isEmailConfirmationLocked(session)) return "email_confirmation";
  if (isSupportEscalationActive(session)) return "support_escalation";
  if (isPaymentCheckoutLocked(session)) return "payment_checkout";
  if (
    session.flowMode === "PURCHASE_FLOW" ||
    isPurchaseFlowActive(session.callSid) ||
    session.sovereignState === "catalog_active" ||
    (session.awaitingInput?.startsWith("product_") ?? false) ||
    session.lastOrchestratorIntent === "catalog" ||
    session.lastOrchestratorIntent === "product_search"
  ) {
    return "product_search";
  }
  if (
    session.awaitingInput === "order_number" ||
    session.phase === "awaiting_order_number" ||
    session.lastOrchestratorIntent === "order_lookup"
  ) {
    return "order_lookup";
  }
  return "idle";
}

export function syncActiveWorkflowContext(session: CallSession): ActiveWorkflowContext {
  const ctx = resolveActiveWorkflowContext(session);
  session.activeWorkflowContext = ctx;
  return ctx;
}

export function isProductSearchContextActive(session?: CallSession): boolean {
  if (!session) return false;
  return (
    session.activeWorkflowContext === "product_search" ||
    isPurchaseFlowActive(session.callSid) ||
    (session.awaitingInput?.startsWith("product_") ?? false)
  );
}

export function isOrderLookupContextActive(session?: CallSession): boolean {
  if (!session) return false;
  return (
    session.activeWorkflowContext === "order_lookup" ||
    session.awaitingInput === "order_number" ||
    session.phase === "awaiting_order_number"
  );
}
