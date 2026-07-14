/**
 * LOCKED_FLOW_STATE — mid-transaction guard for anti-hangup speech.
 * end_call remains in the ToolRegistry at all times (barge-in / hang-up safety).
 * Explicit goodbye may still invoke end_call; premature hangup is blocked separately.
 */
import type { CallSession } from "../types/order.js";

const PAYMENT_LINK_REQUEST_RE =
  /\b(send|email|text|get).{0,30}(payment|checkout|pay).{0,20}(link|email)|payment link|checkout link|send (me |)the link|prepare (my |)payment\b/i;

const PAYMENT_LINK_CONFIRM_RE =
  /\b(yes|yeah|yep|sure|ok|okay|go ahead|please do|that'?s fine|sounds good)\b/i;

/** Caller is requesting or confirming checkout / payment-link delivery. */
export function isPaymentLinkActionUtterance(callerText: string): boolean {
  const text = callerText.trim();
  if (!text) return false;
  if (PAYMENT_LINK_REQUEST_RE.test(text)) return true;
  if (PAYMENT_LINK_CONFIRM_RE.test(text) && /\b(link|checkout|payment|email)\b/i.test(text)) {
    return true;
  }
  return false;
}

/**
 * True when the caller is mid-transaction — cart active or invoice URL pending.
 * Used for anti-hangup speech — NOT to remove end_call from the registry.
 */
export function isLockedFlowState(session?: CallSession): boolean {
  if (!session) return false;
  if ((session.shoppingCart?.length ?? 0) > 0) return true;
  if (session.pendingInvoiceUrl) return true;
  return false;
}

export function buildLockedFlowSystemMessage(session?: CallSession): string | null {
  if (!isLockedFlowState(session)) return null;
  return [
    "LOCKED FLOW STATE (MANDATORY): You are in an active transaction.",
    "Prefer finishing cart/checkout before goodbye. The end_call tool remains AVAILABLE for explicit hang-up / barge-in safety.",
    'Do NOT say goodbye or invoke end_call unless the caller explicitly says goodbye, end call, finished, that\'s all, or declines further help after "anything else?".',
    'After sending a payment link, say: "I am sending the payment link to your email now. Is there anything else I can help you with?" then WAIT.',
    "Never end the call merely because the caller confirmed sending the link.",
  ].join(" ");
}
