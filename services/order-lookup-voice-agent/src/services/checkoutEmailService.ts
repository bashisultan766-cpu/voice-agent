/**
 * Checkout payment-link delivery — shared by LLM tool and deterministic payment flow.
 * Supports full-cart checkout and split-order subset batches (one email per batch).
 */
import type { CallSession } from "../types/order.js";
import {
  deductCheckedOutItems,
  getCartSummary,
  resolveCheckoutLineItems,
  validateCartForCheckout,
  type CheckoutItemSelector,
} from "../agents/cartManager.js";
import { resetEmailConfirmation } from "../agents/emailConfirmationManager.js";
import { createShopifyDraftOrder } from "../adapters/shopifyStorefrontAdapter.js";
import {
  isResendAvailable,
  isValidCustomerEmail,
  sendCheckoutEmail,
} from "../utils/resendEmailService.js";

export const PAYMENT_LINK_SUCCESS_SPEECH =
  "Your payment link has been sent successfully. Please check your inbox.";

export interface CheckoutEmailSendResult {
  ok: boolean;
  message: string;
  invoiceUrl?: string;
  /** True when only a subset of the cart was checked out (split order). */
  splitBatch?: boolean;
  remainingCartUnits?: number;
  checkedOutItems?: Array<{ title: string; quantity: number; variantId: string }>;
}

export interface SendCheckoutPaymentLinkOptions {
  /** Subset of cart lines for this payment link. Omit/empty = entire cart. */
  items?: CheckoutItemSelector[] | null;
  customerName?: string;
}

function normalizeCheckoutSelectors(
  raw: CheckoutItemSelector[] | null | undefined,
): CheckoutItemSelector[] | null {
  if (!raw?.length) return null;
  return raw.map((entry) => ({
    variant_id: entry.variant_id ?? entry.variantId ?? entry.item_id ?? entry.sku,
    variantId: entry.variantId,
    item_id: entry.item_id,
    sku: entry.sku,
    title: entry.title,
    quantity: entry.quantity,
  }));
}

export async function sendCheckoutPaymentLink(
  session: CallSession,
  customerEmail: string,
  customerNameOrOptions?: string | SendCheckoutPaymentLinkOptions,
  maybeOptions?: SendCheckoutPaymentLinkOptions,
): Promise<CheckoutEmailSendResult> {
  const options: SendCheckoutPaymentLinkOptions =
    typeof customerNameOrOptions === "object" && customerNameOrOptions !== null
      ? customerNameOrOptions
      : { ...(maybeOptions ?? {}), customerName: customerNameOrOptions };

  const customerName = (options.customerName ?? "").trim();
  const selectors = normalizeCheckoutSelectors(options.items);
  const resolved = resolveCheckoutLineItems(session, selectors);
  if (!resolved.ok) {
    return { ok: false, message: resolved.message };
  }

  const checkoutItems = resolved.items;
  const isSubset = resolved.isSubset;

  // Confirm-once only for full-cart checkout. Split batches may send multiple links.
  if (!isSubset && session.paymentLinkSent) {
    const prior = session.paymentLinkSentTo ?? customerEmail;
    return {
      ok: true,
      message: `Payment link was already sent to ${prior} during this call.`,
    };
  }

  if (!isValidCustomerEmail(customerEmail)) {
    return { ok: false, message: "Valid customer email required before sending checkout link." };
  }

  if (!checkoutItems.length) {
    return { ok: false, message: "Cart is empty — add books before checkout." };
  }

  const cartValidationError = validateCartForCheckout(checkoutItems);
  if (cartValidationError) {
    return { ok: false, message: cartValidationError };
  }

  if (!isResendAvailable()) {
    return { ok: false, message: "Email service is not configured." };
  }

  try {
    const draft = await createShopifyDraftOrder(
      checkoutItems.map((line) => ({
        quantity: line.quantity,
        variantId: line.variantId.startsWith("custom:") ? undefined : line.variantId,
        title: line.title,
        originalUnitPrice: line.unitPrice ?? line.price,
      })),
      customerEmail,
      customerName,
      session.callSid,
    );

    if (!draft.success || !draft.invoiceUrl) {
      return { ok: false, message: draft.error ?? draft.message ?? "Could not create checkout link." };
    }

    session.pendingInvoiceUrl = draft.invoiceUrl;
    session.pendingDraftOrderName = draft.draftOrderName;

    const emailResult = await sendCheckoutEmail(
      customerEmail,
      customerName,
      draft.invoiceUrl,
      checkoutItems,
    );

    if (!emailResult.ok) {
      return {
        ok: false,
        message: emailResult.error ?? "Could not send checkout email.",
        invoiceUrl: draft.invoiceUrl,
        splitBatch: isSubset,
      };
    }

    if (isSubset) {
      deductCheckedOutItems(session, checkoutItems);
      // Next split batch needs a fresh letter-by-letter email verification.
      resetEmailConfirmation(session);
      if (session.paymentCheckout) {
        session.paymentCheckout.state = "awaiting_email";
      }
    } else {
      // Full-cart checkout — clear remaining lines and lock confirm-once.
      session.shoppingCart = [];
      session.paymentLinkSent = true;
      session.paymentLinkSentTo = customerEmail;
      if (session.paymentCheckout) {
        session.paymentCheckout.state = "completed";
      }
    }

    const remaining = getCartSummary(session);
    if (remaining.isEmpty) {
      session.paymentLinkSent = true;
      session.paymentLinkSentTo = customerEmail;
      if (session.paymentCheckout) {
        session.paymentCheckout.state = "completed";
      }
    }

    const checkedOutItems = checkoutItems.map((line) => ({
      title: line.title,
      quantity: line.quantity,
      variantId: line.variantId,
    }));

    const batchNote = isSubset
      ? remaining.isEmpty
        ? " That was the last batch — the cart is now empty."
        : ` ${remaining.totalUnits} book(s) remain in the cart for the next email.`
      : "";

    return {
      ok: true,
      message: `${PAYMENT_LINK_SUCCESS_SPEECH}${batchNote}`,
      invoiceUrl: draft.invoiceUrl,
      splitBatch: isSubset,
      remainingCartUnits: remaining.totalUnits,
      checkedOutItems,
    };
  } catch {
    return { ok: false, message: "Could not create checkout link." };
  }
}
