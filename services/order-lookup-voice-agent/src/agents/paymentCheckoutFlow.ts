/**
 * Payment-link checkout workflow — separate from support escalation.
 * Reuses the central Email Confirmation Engine for email capture.
 */
import type { CallSession } from "../types/order.js";
import { logger } from "../utils/logger.js";
import { getCartSummary, getLineMerchandiseTotal } from "./cartManager.js";
import {
  buildEmailCapturePrompt,
  isEmailConfirmationActive,
  registerEmailWorkflowExecutor,
  startEmailCapture,
} from "./emailConfirmationManager.js";
import {
  PAYMENT_LINK_SUCCESS_SPEECH,
  sendCheckoutPaymentLink,
} from "../services/checkoutEmailService.js";
import { isPaymentLinkActionUtterance } from "./lockedFlowState.js";

export type PaymentCheckoutState = "idle" | "awaiting_email" | "completed";

export interface PaymentCheckoutContext {
  state: PaymentCheckoutState;
  customerName?: string;
}

const CHECKOUT_READY_RE =
  /\b(ready\s+to\s+(?:checkout|pay|order)|checkout|check\s+out|send\s+(?:me\s+)?(?:the\s+)?(?:payment|checkout)\s+link|pay\s+now|place\s+(?:the\s+)?order|proceed\s+to\s+payment)\b/i;

function ensurePaymentCheckout(session: CallSession): PaymentCheckoutContext {
  if (!session.paymentCheckout) {
    session.paymentCheckout = { state: "idle" };
  }
  return session.paymentCheckout;
}

export function isPaymentCheckoutActive(session?: CallSession): boolean {
  if (!session) return false;
  if (isEmailConfirmationActive(session) && session.emailConfirmation?.workflowType === "payment_link") {
    return true;
  }
  const state = session.paymentCheckout?.state ?? "idle";
  return state === "awaiting_email";
}

export function isPaymentCheckoutLocked(session?: CallSession): boolean {
  return isPaymentCheckoutActive(session);
}

export function buildCheckoutSummarySpeech(session: CallSession): string {
  const summary = getCartSummary(session);
  if (summary.isEmpty) {
    return "Your cart is empty. Tell me which book you would like to add first.";
  }

  const lines = summary.items.map((line) => {
    const price = line.unitPrice ?? line.price ?? "";
    const lineTotal = getLineMerchandiseTotal(line);
    const pricePart = price ? ` at ${price} each` : "";
    return `${line.quantity} copy${line.quantity === 1 ? "" : " copies"} of ${line.title}${pricePart}${lineTotal ? `, line total ${lineTotal}` : ""}`;
  });

  const parts = [
    "Here is your order summary.",
    lines.join(". "),
    `Merchandise subtotal: ${summary.merchandiseTotal}.`,
    "Shipping is calculated at checkout.",
    "When you are ready, I will email you a secure payment link.",
  ];
  return parts.join(" ");
}

function beginPaymentEmailCapture(session: CallSession): string {
  const ctx = ensurePaymentCheckout(session);
  ctx.state = "awaiting_email";
  startEmailCapture(session, "payment_link");
  logger.info("payment_checkout_email_started", {
    callSid: session.callSid.slice(0, 8),
  });
  return `${buildCheckoutSummarySpeech(session)} ${buildEmailCapturePrompt("payment_link")}`;
}

export function isCheckoutReadyUtterance(text: string): boolean {
  return CHECKOUT_READY_RE.test(text.trim()) || isPaymentLinkActionUtterance(text);
}

async function executePaymentLinkEmail(
  session: CallSession,
  confirmedEmail: string,
): Promise<{ ok: boolean; successSpeech: string; failureSpeech: string }> {
  const ctx = ensurePaymentCheckout(session);
  const name = ctx.customerName ?? String(session.currentOrderData?.customer_name ?? "").trim();
  const result = await sendCheckoutPaymentLink(session, confirmedEmail, name || undefined);
  if (result.ok) {
    ctx.state = "completed";
    logger.info("payment_link_sent", {
      callSid: session.callSid.slice(0, 8),
    });
    return {
      ok: true,
      successSpeech: PAYMENT_LINK_SUCCESS_SPEECH,
      failureSpeech: "",
    };
  }
  return {
    ok: false,
    successSpeech: "",
    failureSpeech: `I had trouble sending your payment link. ${result.message} Please say your email again and I will retry.`,
  };
}

let executorsRegistered = false;

export function ensurePaymentCheckoutExecutors(): void {
  if (executorsRegistered) return;
  registerEmailWorkflowExecutor("payment_link", executePaymentLinkEmail);
  executorsRegistered = true;
}

/**
 * Deterministic payment-checkout turn — runs after email confirmation gate.
 */
export function resolvePaymentCheckoutTurn(
  session: CallSession,
  callerText: string,
): { handled: true; speech: string } | { handled: false } {
  ensurePaymentCheckoutExecutors();

  const text = (callerText ?? "").trim();
  if (!text) return { handled: false };

  if (isEmailConfirmationActive(session)) {
    return { handled: false };
  }

  const summary = getCartSummary(session);
  if (summary.isEmpty) return { handled: false };

  const ctx = ensurePaymentCheckout(session);
  if (ctx.state === "completed" || session.paymentLinkSent) {
    return { handled: false };
  }

  if (!isCheckoutReadyUtterance(text)) {
    return { handled: false };
  }

  const speech = beginPaymentEmailCapture(session);
  return { handled: true, speech };
}
