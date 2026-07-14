/**
 * CheckoutManager — iterative multi-batch payment state machine (SSOT for checkout).
 * Cart quantity/SKU counts always come from CartState (shoppingCart + currentSessionCart);
 * CheckoutSession.remainingItems / CartIterator mirror unpaid lines only.
 * Reuses the Email Confirmation Engine for Semantic Slot / PartialCorrection repair.
 */
import type { CallSession, ShoppingCartLineItem } from "../types/order.js";
import { logger } from "../utils/logger.js";
import {
  ensureShoppingCart,
  getCartState,
  getCartSummary,
  getLineMerchandiseTotal,
  resolveCheckoutLineItems,
  type CheckoutItemSelector,
} from "./cartManager.js";
import {
  buildEmailCapturePrompt,
  getLatestConfirmedEmailId,
  isEmailConfirmationActive,
  issueConfirmedEmail,
  registerEmailWorkflowExecutor,
  startEmailCapture,
} from "./emailConfirmationManager.js";
import { isPaymentLinkActionUtterance } from "./lockedFlowState.js";
import {
  gateBatchForLogistics,
  verifyStockAvailability,
  type LiveInventoryMap,
} from "./logisticsIntelligence.js";
import { teardownSession } from "./sessionTeardown.js";
import { isCheckoutPassiveReadOnly } from "./flowMutex.js";
import { runCartValidationGate } from "./cartValidationGate.js";
import { recordFailureState } from "./failureState.js";
import { planCheckoutGroup, cartLinesToGroupLines } from "../domain/checkoutModels.js";
import { ActionGateway } from "../runtime/actionGateway.js";
import { ensureSessionMemory } from "./sessionMemory.js";
import { getActiveOrderContext } from "./sessionManager.js";

export const PAYMENT_LINK_SUCCESS_SPEECH =
  "Your payment link has been sent successfully. Please check your inbox.";

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
  /** Confirmed = payment link emailed; pending = batch selected awaiting send. */
  status: "pending" | "confirmed";
}

/**
 * Multi-batch split-payment orchestrator state (CartIterator).
 * remainingItems mirrors unpaid cart lines; currentBatch / confirmedBatch is the next payment-link subset.
 * processedItems tracks SKUs already emailed — cart_items only shrink after successful payment tool.
 */
export interface CheckoutSession {
  active: boolean;
  phase: PaymentCheckoutState;
  /** CartIterator — unpaid SKU/qty lines remaining to batch (= live cart when in sync). */
  remainingItems: CheckoutBatchLine[];
  /** Alias view: cart_items still awaiting payment links. */
  cartItems?: CheckoutBatchLine[];
  /** SKUs already successfully emailed (atomic after payment tool success). */
  processedItems: CheckoutBatchLine[];
  currentBatch: CheckoutBatchLine[];
  /** Temporary confirmed batch awaiting (or paired with) email — atomic sku_list + email_address. */
  confirmedBatch?: {
    items: CheckoutBatchLine[];
    emailAddress?: string;
  };
  completedBatches: CompletedCheckoutBatch[];
  /** 1-based batch counter for speech ("first email", "second email"). */
  batchNumber: number;
  targetEmail?: string;
}

/** Alias — CartIterator is the remaining-items list on CheckoutSession. */
export type CartIterator = CheckoutBatchLine[];


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

/** Sync remainingItems / CartIterator from live CartState (SSOT after cart mutations / deduct). */
export function syncCheckoutRemainingFromCart(session: CallSession): CheckoutSession | undefined {
  const ctx = session.paymentCheckout;
  const cs = ctx?.checkoutSession;
  if (!cs?.active) return cs;
  cs.remainingItems = cartToRemaining(session);
  cs.cartItems = cs.remainingItems;
  if (!cs.processedItems) cs.processedItems = [];
  if (!cs.remainingItems.length) {
    cs.phase = "completed";
    cs.currentBatch = [];
    if (ctx) ctx.state = "completed";
  }
  return cs;
}

/** Read the CartIterator (remaining unpaid lines). Empty when checkout is done. */
export function getCartIterator(session: CallSession): CartIterator {
  const cs = getCheckoutSession(session);
  if (cs?.active) return cs.remainingItems;
  return cartToRemaining(session);
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
    cartItems: remaining,
    processedItems: ctx.checkoutSession?.processedItems ?? [],
    currentBatch: [],
    confirmedBatch: undefined,
    completedBatches: ctx.checkoutSession?.completedBatches ?? [],
    batchNumber: (ctx.checkoutSession?.completedBatches?.length ?? 0) + 1,
  };
  ctx.checkoutSession = checkoutSession;
  ctx.state = checkoutSession.phase;
  logger.info("multi_batch_checkout_started", {
    callSid: session.callSid.slice(0, 8),
    remainingUnits: remaining.reduce((sum, line) => sum + line.quantity, 0),
    remainingLines: remaining.length,
    cartStateUnits: getCartState(session).totalUnits,
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
  cs.confirmedBatch = { items: cs.currentBatch };
  cs.phase = "awaiting_batch_email";
  ctx.state = "awaiting_batch_email";
  return { ok: true, batch: cs.currentBatch };
}

/**
 * initiate_checkout_batch — Iterator step: lock sku_list as currentBatch, then email capture.
 * Atomic Finality Gate: verify_stock_availability + logistics shipability before locking batch.
 * Call after the agent identifies which SKUs go to this email; CartState may update if stock/logistics change.
 */
export function initiateCheckoutBatch(
  session: CallSession,
  selectors: CheckoutItemSelector[],
  options?: {
    startEmailCapture?: boolean;
    /** Injectable live inventory for Atomic Finality / unit tests. */
    liveInventory?: LiveInventoryMap;
    facilityType?: string;
    inventoryUnavailable?: boolean;
  },
):
  | {
      ok: true;
      batch: CheckoutBatchLine[];
      remainingUnits: number;
      speech: string;
      cartUpdated?: boolean;
      stockVerified?: boolean;
      logisticsGated?: boolean;
      checkoutGroupId?: string;
    }
  | { ok: false; message: string; cartUpdated?: boolean; failureState?: string } {
  // Batch prep runs BEFORE email confirm — gate stock/logistics/ISBN only.
  const gate = runCartValidationGate(session, {
    selectors,
    liveInventory: options?.liveInventory,
    inventoryUnavailable: options?.inventoryUnavailable,
    facilityType: options?.facilityType ?? session.facilityType,
    requireConfirmedEmail: false,
  });
  if (!gate.ok) {
    recordFailureState(
      session,
      gate.failureState ?? "CART_VALIDATION",
      gate.message,
      "initiate_checkout_batch",
    );
    return {
      ok: false,
      message: gate.message,
      failureState: gate.failureState,
      cartUpdated: gate.failureState === "INVENTORY_BLOCKED" || gate.failureState === "LOGISTICS_BLOCKED",
    };
  }

  const preamble: string[] = [];
  if (gate.logisticsSpeech) preamble.push(gate.logisticsSpeech);
  if (gate.stockSpeech) preamble.push(gate.stockSpeech);

  const assigned = setCurrentCheckoutBatch(session, gate.selectors ?? selectors);
  if (!assigned.ok) return assigned;

  const groupLines = cartLinesToGroupLines(
    assigned.batch.map((line) => ({
      variantId: line.variantId,
      productId: "",
      title: line.title,
      quantity: line.quantity,
    })),
  );
  const planned = planCheckoutGroup(session, groupLines);
  const checkoutGroupId = planned.ok ? planned.group.checkoutGroupId : undefined;
  if (checkoutGroupId) {
    ensureSessionMemory(session).latestCheckoutGroupId = checkoutGroupId;
  }

  const units = assigned.batch.reduce((sum, line) => sum + line.quantity, 0);
  const remaining = remainingUnits(session);
  if (options?.startEmailCapture !== false) {
    startEmailCapture(session, "payment_link");
    ensurePaymentCheckout(session).state = "awaiting_batch_email";
  }

  const titles = assigned.batch
    .map((line) => `${line.quantity} of ${line.title}`)
    .join(", ");
  const batchSpeech =
    `I've prepared a payment batch for ${titles} (${units} item${units === 1 ? "" : "s"}). ` +
    `${remaining - units > 0 ? `${remaining - units} will remain after this link is sent. ` : ""}` +
    buildEmailCapturePrompt("payment_link");

  const speech = preamble.length ? `${preamble.join(" ")} ${batchSpeech}` : batchSpeech;

  logger.info("initiate_checkout_batch", {
    callSid: session.callSid.slice(0, 8),
    batchUnits: units,
    remainingUnits: remaining,
    checkoutGroupId,
    cartUpdated: Boolean(gate.logisticsSpeech || gate.stockSpeech),
    stockVerified: true,
  });

  return {
    ok: true,
    batch: assigned.batch,
    remainingUnits: remaining,
    speech,
    checkoutGroupId,
    cartUpdated: Boolean(gate.logisticsSpeech || gate.stockSpeech),
    stockVerified: true,
    logisticsGated: Boolean(gate.logisticsSpeech),
  };
}

/**
 * Production path — refreshes liveInventory from Shopify Admin before Atomic Finality.
 * Prefer this over sync initiateCheckoutBatch outside unit tests.
 */
export async function initiateCheckoutBatchWithLiveInventory(
  session: CallSession,
  selectors: CheckoutItemSelector[],
  options?: {
    startEmailCapture?: boolean;
    liveInventory?: LiveInventoryMap;
    facilityType?: string;
  },
): Promise<ReturnType<typeof initiateCheckoutBatch>> {
  if (isCheckoutPassiveReadOnly(session)) {
    return {
      ok: false,
      message:
        "I've paused checkout while we connect you with a human agent. I won't process payment links until that handoff is complete.",
    };
  }

  let liveInventory = options?.liveInventory;
  let inventoryUnavailable = false;
  if (!liveInventory) {
    const { fetchLiveInventoryByVariantIds, collectVariantIdsForInventory } = await import(
      "../services/shopifyInventoryService.js"
    );
    const resolved = resolveCheckoutLineItems(session, selectors);
    if (resolved.ok) {
      const refreshed = await fetchLiveInventoryByVariantIds(
        collectVariantIdsForInventory(resolved.items),
      );
      liveInventory = refreshed.map;
      inventoryUnavailable = refreshed.unavailable;
    }
  }
  return initiateCheckoutBatch(session, selectors, {
    ...options,
    liveInventory,
    inventoryUnavailable,
  });
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
  const batchLines = items.map(toBatchLine);
  cs.completedBatches.push({
    email,
    items: batchLines,
    sentAt: Date.now(),
    invoiceUrl,
    status: "confirmed",
  });
  cs.processedItems = [...(cs.processedItems ?? []), ...batchLines];
  cs.confirmedBatch = undefined;
  cs.currentBatch = [];
  cs.targetEmail = undefined;
  syncCheckoutRemainingFromCart(session);
  cs.cartItems = cs.remainingItems;

  if (cs.remainingItems.length) {
    cs.phase = "confirming_continue";
    cs.batchNumber = cs.completedBatches.length + 1;
    ctx.state = "confirming_continue";
  } else {
    cs.phase = "completed";
    cs.active = false;
    ctx.state = "completed";
  }

  // If Sentiment Shield was deferred mid-batch, fire it now that the batch finished.
  void import("../utils/sentiment.js").then(({ flushPendingSentimentShield }) => {
    flushPendingSentimentShield(session);
  });

  return cs;
}

/**
 * CheckoutManager facade — consolidate cart-aware checkout into one module surface.
 * Prefer these entry points over ad-hoc cart/checkout helpers in prompts and tools.
 */
export const CheckoutManager = {
  getCartState,
  getCartIterator,
  startMultiBatchCheckout,
  setCurrentCheckoutBatch,
  initiateCheckoutBatch,
  initiateCheckoutBatchWithLiveInventory,
  recordCompletedCheckoutBatch,
  syncCheckoutRemainingFromCart,
  remainingUnits,
  buildSplitBatchPrompt,
  buildPostBatchRemainingSpeech,
  resolvePaymentCheckoutTurn,
  ensurePaymentCheckoutExecutors,
  /** Atomic Finality inventory double-check (also runs inside initiateCheckoutBatch). */
  verifyStockAvailability,
  /** Packaging / shipability gate for a facility. */
  gateBatchForLogistics,
  /** processed_items vs cart_items snapshot for batch orchestration. */
  getProcessedVsCart(session: CallSession): {
    processed_items: CheckoutBatchLine[];
    cart_items: CheckoutBatchLine[];
    confirmed_batch?: CheckoutSession["confirmedBatch"];
  } {
    const cs = getCheckoutSession(session);
    const cart = cartToRemaining(session);
    return {
      processed_items: cs?.processedItems ?? [],
      cart_items: cs?.cartItems ?? cs?.remainingItems ?? cart,
      confirmed_batch: cs?.confirmedBatch,
    };
  },
} as const;

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
      `I've sent the payment link for your items to ${email}. That was the last batch — nothing remains in the cart. ` +
      `Is there anything else I can help you with?`
    );
  }
  const batch = session.paymentCheckout?.checkoutSession?.completedBatches?.at(-1);
  const sentUnits = batch?.items.reduce((sum, line) => sum + line.quantity, 0) ?? 0;
  const x = sentUnits > 0 ? sentUnits : 0;
  return (
    `I've sent the payment link for ${x} item${x === 1 ? "" : "s"}. ` +
    `Shall we proceed with the remaining ${units} item${units === 1 ? "" : "s"}?`
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
  const name = ctx.customerName ?? String(getActiveOrderContext(session)?.customer_name ?? "").trim();
  const memory = ensureSessionMemory(session);

  let emailId = getLatestConfirmedEmailId(session);
  if (!emailId) {
    emailId = issueConfirmedEmail(session, confirmedEmail, "payment_link").confirmedEmailId;
  }

  let checkoutGroupId = memory.latestCheckoutGroupId;
  if (!checkoutGroupId) {
    const cs = ctx.checkoutSession;
    const lines =
      cs?.active && cs.currentBatch.length
        ? cs.currentBatch.map((line) => ({
            variantId: line.variantId,
            productId: "",
            title: line.title,
            quantity: line.quantity,
          }))
        : getCartSummary(session).items;
    const planned = planCheckoutGroup(session, cartLinesToGroupLines(lines));
    if (!planned.ok) {
      return {
        ok: false,
        successSpeech: "",
        failureSpeech: planned.message,
      };
    }
    checkoutGroupId = planned.group.checkoutGroupId;
    memory.latestCheckoutGroupId = checkoutGroupId;
  }

  const result = await ActionGateway.executeCheckoutGroup(
    {
      session,
      checkoutGroupId,
      confirmedEmailId: emailId,
      customerName: name || undefined,
    },
    {
      callId: session.callSid,
      actionId: `pay_${Date.now().toString(36)}`,
      workflowId: "payment_checkout_flow",
      idempotencyKey: `idem_${checkoutGroupId}`,
    },
  );

  if (result.ok) {
    if ((result.remainingUnits ?? 0) <= 0) {
      ctx.state = "completed";
    }
    logger.info("payment_link_sent", {
      callSid: session.callSid.slice(0, 8),
      splitBatch: (result.remainingUnits ?? 0) > 0,
      remaining: result.remainingUnits ?? 0,
      checkoutGroupId,
    });
    const successSpeech =
      (result.remainingUnits ?? 0) > 0
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
    failureSpeech: result.invoiceUrl
      ? `I couldn't email the link, but here it is: ${result.invoiceUrl}`
      : `I had trouble sending your payment link. ${result.message} Please say your email again and I will retry.`,
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
    if (/\b(yes|yeah|yep|sure|ok|okay|different|another|next|proceed|continue)\b/i.test(text)) {
      ctx.state = "selecting_batch";
      ctx.checkoutSession.phase = "selecting_batch";
      return { handled: true, speech: buildSplitBatchPrompt(session) };
    }
    // Explicit stop/done — end split-checkout without forcing remaining batches.
    if (
      /\b(no|nope|stop|done|finished|that'?s all|thats all|nothing else|i'?m good|cancel|never\s*mind)\b/i.test(
        text,
      )
    ) {
      ctx.state = "completed";
      ctx.checkoutSession.active = false;
      ctx.checkoutSession.phase = "completed";
      teardownSession(session, {
        reason: "split_checkout_declined_remaining",
        preservePaymentSentFlags: true,
      });
      return {
        handled: true,
        speech:
          "Understood — I'll leave the remaining books in your cart for now. Is there anything else I can help you with?",
      };
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
