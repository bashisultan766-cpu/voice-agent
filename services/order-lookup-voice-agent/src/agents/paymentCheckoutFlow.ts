/**
 * Payment-link checkout workflow — full-cart and multi-batch split payment.
 * Reuses the central Email Confirmation Engine for email capture / contextual repair.
 */
import type { CallSession, ShoppingCartLineItem } from "../types/order.js";
import { logger } from "../utils/logger.js";
import {
  ensureShoppingCart,
  getCartSummary,
  getLineMerchandiseTotal,
  resolveCheckoutLineItems,
  type CheckoutItemSelector,
} from "./cartManager.js";
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

export type PaymentCheckoutState =
  | "idle"
  | "awaiting_email"
  | "selecting_batch"
  | "awaiting_batch_email"
  | "confirming_continue"
  | "completed";

export interface CheckoutBatchLine {
  variantId: string;
  title: string;
  quantity: number;
}

export interface CompletedCheckoutBatch {
  email: string;
  items: CheckoutBatchLine[];
  sentAt: number;
  invoiceUrl?: string;
}

/**
 * Multi-batch split-payment orchestrator state.
 * remainingItems mirrors unpaid cart lines; currentBatch is the next payment-link subset.
 */
export interface CheckoutSession {
  active: boolean;
  phase: PaymentCheckoutState;
  remainingItems: CheckoutBatchLine[];
  currentBatch: CheckoutBatchLine[];
  completedBatches: CompletedCheckoutBatch[];
  /** 1-based batch counter for speech ("first email", "second email"). */
  batchNumber: number;
  targetEmail?: string;
}

export interface PaymentCheckoutContext {
  state: PaymentCheckoutState;
  customerName?: string;
  /** Present when multi-recipient / split checkout is active. */
  checkoutSession?: CheckoutSession;
}

const CHECKOUT_READY_RE =
  /\b(ready\s+to\s+(?:checkout|pay|order)|checkout|check\s+out|send\s+(?:me\s+)?(?:the\s+)?(?:payment|checkout)\s+link|pay\s+now|place\s+(?:the\s+)?order|proceed\s+to\s+payment)\b/i;

const SPLIT_INTENT_RE =
  /\b(split|different\s+email|separate\s+email|two\s+email|multiple\s+email|another\s+email|first\s+email|second\s+email)\b/i;

function toBatchLine(line: ShoppingCartLineItem): CheckoutBatchLine {
  return {
    variantId: line.variantId,
    title: line.title,
    quantity: line.quantity,
  };
}

function cartToRemaining(session: CallSession): CheckoutBatchLine[] {
  return ensureShoppingCart(session).map(toBatchLine);
}

export function ensurePaymentCheckout(session: CallSession): PaymentCheckoutContext {
  if (!session.paymentCheckout) {
    session.paymentCheckout = { state: "idle" };
  }
  return session.paymentCheckout;
}

export function getCheckoutSession(session: CallSession): CheckoutSession | undefined {
  return session.paymentCheckout?.checkoutSession;
}

/** Sync remainingItems from live cart (source of truth after applySessionCartQuantity / deduct). */
export function syncCheckoutRemainingFromCart(session: CallSession): CheckoutSession | undefined {
  const ctx = session.paymentCheckout;
  const cs = ctx?.checkoutSession;
  if (!cs?.active) return cs;
  cs.remainingItems = cartToRemaining(session);
  if (!cs.remainingItems.length) {
    cs.phase = "completed";
    cs.currentBatch = [];
    if (ctx) ctx.state = "completed";
  }
  return cs;
}

/**
 * Start (or refresh) multi-batch split checkout without dumping a full cart summary.
 */
export function startMultiBatchCheckout(session: CallSession): CheckoutSession {
  const ctx = ensurePaymentCheckout(session);
  const remaining = cartToRemaining(session);
  const checkoutSession: CheckoutSession = {
    active: true,
    phase: remaining.length ? "selecting_batch" : "completed",
    remainingItems: remaining,
    currentBatch: [],
    completedBatches: ctx.checkoutSession?.completedBatches ?? [],
    batchNumber: (ctx.checkoutSession?.completedBatches?.length ?? 0) + 1,
  };
  ctx.checkoutSession = checkoutSession;
  ctx.state = checkoutSession.phase;
  logger.info("multi_batch_checkout_started", {
    callSid: session.callSid.slice(0, 8),
    remainingUnits: remaining.reduce((sum, line) => sum + line.quantity, 0),
    remainingLines: remaining.length,
  });
  return checkoutSession;
}

/** Assign the working batch from title / variant / 1-based cart position selectors. */
export function setCurrentCheckoutBatch(
  session: CallSession,
  selectors: CheckoutItemSelector[],
): { ok: true; batch: CheckoutBatchLine[] } | { ok: false; message: string } {
  const resolved = resolveCheckoutLineItems(session, selectors);
  if (!resolved.ok) return resolved;
  if (!resolved.isSubset) {
    return { ok: false, message: "Provide a specific batch of books for this email." };
  }

  const ctx = ensurePaymentCheckout(session);
  if (!ctx.checkoutSession?.active) {
    startMultiBatchCheckout(session);
  }
  const cs = ctx.checkoutSession!;
  cs.currentBatch = resolved.items.map(toBatchLine);
  cs.phase = "awaiting_batch_email";
  ctx.state = "awaiting_batch_email";
  return { ok: true, batch: cs.currentBatch };
}

export function recordCompletedCheckoutBatch(
  session: CallSession,
  email: string,
  items: ShoppingCartLineItem[],
  invoiceUrl?: string,
): CheckoutSession {
  const ctx = ensurePaymentCheckout(session);
  if (!ctx.checkoutSession?.active) {
    startMultiBatchCheckout(session);
  }
  const cs = ctx.checkoutSession!;
  cs.completedBatches.push({
    email,
    items: items.map(toBatchLine),
    sentAt: Date.now(),
    invoiceUrl,
  });
  cs.currentBatch = [];
  cs.targetEmail = undefined;
  syncCheckoutRemainingFromCart(session);

  if (cs.remainingItems.length) {
    cs.phase = "confirming_continue";
    cs.batchNumber = cs.completedBatches.length + 1;
    ctx.state = "confirming_continue";
  } else {
    cs.phase = "completed";
    cs.active = false;
    ctx.state = "completed";
  }
  return cs;
}

export function remainingUnits(session: CallSession): number {
  const cs = getCheckoutSession(session);
  if (cs?.active) {
    return cs.remainingItems.reduce((sum, line) => sum + line.quantity, 0);
  }
  return getCartSummary(session).totalUnits;
}

export function buildSplitBatchPrompt(session: CallSession): string {
  const cs = getCheckoutSession(session) ?? startMultiBatchCheckout(session);
  const remaining = cs.remainingItems;
  if (!remaining.length) {
    return "Your cart is empty. Tell me which book you would like to add first.";
  }

  const first = remaining[0]!;
  const ordinal =
    cs.batchNumber === 1 ? "first" : cs.batchNumber === 2 ? "second" : `${cs.batchNumber}th`;
  const units = remaining.reduce((sum, line) => sum + line.quantity, 0);

  if (remaining.length === 1) {
    return (
      `I can split this across emails one batch at a time. ` +
      `How many copies of ${first.title} should go to the ${ordinal} email? ` +
      `You currently have ${units} remaining.`
    );
  }

  return (
    `I can absolutely split this up for you. Let's do this one step at a time so nothing gets mixed up. ` +
    `How many copies of ${first.title} should go to the ${ordinal} email, ` +
    `or which books by title or cart position (for example, the first two books) should I include? ` +
    `You have ${units} items remaining across ${remaining.length} titles.`
  );
}

export function buildPostBatchRemainingSpeech(session: CallSession, email: string): string {
  const units = remainingUnits(session);
  if (units <= 0) {
    return (
      `Payment link sent to ${email}. That was the last batch — nothing remains in the cart. ` +
      `Is there anything else I can help you with?`
    );
  }
  return (
    `Payment link sent to ${email}. You have ${units} item${units === 1 ? "" : "s"} remaining. ` +
    `Would you like to send these to a different email?`
  );
}

export function isPaymentCheckoutActive(session?: CallSession): boolean {
  if (!session) return false;
  if (isEmailConfirmationActive(session) && session.emailConfirmation?.workflowType === "payment_link") {
    return true;
  }
  const state = session.paymentCheckout?.state ?? "idle";
  if (
    state === "awaiting_email" ||
    state === "selecting_batch" ||
    state === "awaiting_batch_email" ||
    state === "confirming_continue"
  ) {
    return true;
  }
  return Boolean(session.paymentCheckout?.checkoutSession?.active);
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

function beginPaymentEmailCapture(session: CallSession, opts?: { split?: boolean }): string {
  const ctx = ensurePaymentCheckout(session);
  if (opts?.split) {
    startMultiBatchCheckout(session);
    ctx.state = "selecting_batch";
    logger.info("payment_checkout_split_started", {
      callSid: session.callSid.slice(0, 8),
    });
    return buildSplitBatchPrompt(session);
  }

  ctx.state = "awaiting_email";
  startEmailCapture(session, "payment_link");
  logger.info("payment_checkout_email_started", {
    callSid: session.callSid.slice(0, 8),
  });
  // Full-cart only: brief confirmation — avoid dumping a long summary mid-split.
  return `I can email you a secure payment link for your cart. ${buildEmailCapturePrompt("payment_link")}`;
}

export function isCheckoutReadyUtterance(text: string): boolean {
  return CHECKOUT_READY_RE.test(text.trim()) || isPaymentLinkActionUtterance(text);
}

export function isSplitCheckoutIntent(text: string): boolean {
  return SPLIT_INTENT_RE.test(text.trim());
}

async function executePaymentLinkEmail(
  session: CallSession,
  confirmedEmail: string,
): Promise<{ ok: boolean; successSpeech: string; failureSpeech: string }> {
  const ctx = ensurePaymentCheckout(session);
  const name = ctx.customerName ?? String(session.currentOrderData?.customer_name ?? "").trim();
  const cs = ctx.checkoutSession;
  const batchSelectors: CheckoutItemSelector[] | undefined =
    cs?.active && cs.currentBatch.length
      ? cs.currentBatch.map((line) => ({
          variant_id: line.variantId,
          title: line.title,
          quantity: line.quantity,
        }))
      : undefined;

  const result = await sendCheckoutPaymentLink(session, confirmedEmail, {
    customerName: name || undefined,
    items: batchSelectors,
  });

  if (result.ok) {
    if (!result.splitBatch || (result.remainingCartUnits ?? 0) <= 0) {
      ctx.state = "completed";
    }
    logger.info("payment_link_sent", {
      callSid: session.callSid.slice(0, 8),
      splitBatch: Boolean(result.splitBatch),
      remaining: result.remainingCartUnits ?? 0,
    });
    const successSpeech =
      result.splitBatch
        ? buildPostBatchRemainingSpeech(session, confirmedEmail)
        : PAYMENT_LINK_SUCCESS_SPEECH;
    return {
      ok: true,
      successSpeech,
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

  // Resume split loop after a batch without re-dumping cart summary.
  if (ctx.checkoutSession?.active && ctx.state === "confirming_continue") {
    if (/\b(yes|yeah|yep|sure|ok|okay|different|another|next)\b/i.test(text)) {
      ctx.state = "selecting_batch";
      ctx.checkoutSession.phase = "selecting_batch";
      return { handled: true, speech: buildSplitBatchPrompt(session) };
    }
  }

  if (!isCheckoutReadyUtterance(text) && !isSplitCheckoutIntent(text)) {
    return { handled: false };
  }

  const split =
    isSplitCheckoutIntent(text) ||
    Boolean(ctx.checkoutSession?.active) ||
    summary.items.length > 1;

  const speech = beginPaymentEmailCapture(session, { split });
  return { handled: true, speech };
}
