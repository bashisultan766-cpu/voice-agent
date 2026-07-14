/**
 * Global session teardown — clears transaction locks after a completed payment path.
 * Every successful transactional completion MUST call this so isLockedFlowState is false
 * when the cart is empty and no further batches remain.
 */
import type { CallSession } from "../types/order.js";
import { logger } from "../utils/logger.js";
import { isLockedFlowState } from "./lockedFlowState.js";

export interface TeardownSessionOptions {
  /** Keep paymentLinkSent flags (confirm-once) while clearing lock fields. */
  preservePaymentSentFlags?: boolean;
  reason?: string;
}

/**
 * Clear pendingInvoiceUrl / draft locks. When the cart is empty, also mark checkout complete
 * so the caller can hang up. Does not wipe shoppingCart mid-split.
 */
export function teardownSession(
  session: CallSession,
  options?: TeardownSessionOptions,
): { lockedAfter: boolean } {
  session.pendingInvoiceUrl = undefined;
  session.pendingDraftOrderName = undefined;

  const cartEmpty = (session.shoppingCart?.length ?? 0) === 0;
  if (cartEmpty) {
    if (session.paymentCheckout) {
      session.paymentCheckout.state = "completed";
      if (session.paymentCheckout.checkoutSession) {
        session.paymentCheckout.checkoutSession.active = false;
        session.paymentCheckout.checkoutSession.phase = "completed";
        session.paymentCheckout.checkoutSession.remainingItems = [];
        session.paymentCheckout.checkoutSession.currentBatch = [];
      }
    }
    if (!options?.preservePaymentSentFlags) {
      // Keep paymentLinkSent for confirm-once — only clear lock fields above.
    }
  }

  const lockedAfter = isLockedFlowState(session);
  logger.info("teardown_session", {
    callSid: session.callSid.slice(0, 8),
    reason: options?.reason ?? "transaction_complete",
    cartEmpty,
    lockedAfter,
  });
  return { lockedAfter };
}

/** Assert helper for tests / post-transaction verification. */
export function assertTransactionUnlocked(session: CallSession): boolean {
  return !isLockedFlowState(session) || (session.shoppingCart?.length ?? 0) > 0;
}
