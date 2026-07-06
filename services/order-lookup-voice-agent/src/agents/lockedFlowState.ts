/**
 * LOCKED_FLOW_STATE — active transactions where end_call must be disabled.
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
 * True when the caller is mid-transaction — cart active, checkout in flight, or payment link requested.
 * In this state end_call is physically removed from the tool list.
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
    "The end_call tool is DISABLED — you cannot invoke it.",
    'You are STRICTLY FORBIDDEN from saying goodbye, "Have a wonderful day", or any closing phrase unless the caller explicitly says goodbye, end call, or finished.',
    'After sending or confirming a payment link, say: "I am sending the payment link to your email now. Is there anything else I can help you with?" then WAIT for the caller — NEVER auto-hangup.',
    "Never end the call because the caller confirmed an action like sending the link.",
  ].join(" ");
}
