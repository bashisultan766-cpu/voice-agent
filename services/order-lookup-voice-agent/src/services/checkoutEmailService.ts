/**
 * Checkout payment-link delivery — shared by LLM tool and deterministic payment flow.
 */
import type { CallSession } from "../types/order.js";
import { getCartSummary, validateCartForCheckout } from "../agents/cartManager.js";
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
}

export async function sendCheckoutPaymentLink(
  session: CallSession,
  customerEmail: string,
  customerName?: string,
): Promise<CheckoutEmailSendResult> {
  if (session.paymentLinkSent) {
    const prior = session.paymentLinkSentTo ?? customerEmail;
    return {
      ok: true,
      message: `Payment link was already sent to ${prior} during this call.`,
    };
  }

  if (!isValidCustomerEmail(customerEmail)) {
    return { ok: false, message: "Valid customer email required before sending checkout link." };
  }

  const summary = getCartSummary(session);
  if (summary.isEmpty) {
    return { ok: false, message: "Cart is empty — add books before checkout." };
  }

  const cartValidationError = validateCartForCheckout(summary.items);
  if (cartValidationError) {
    return { ok: false, message: cartValidationError };
  }

  if (!isResendAvailable()) {
    return { ok: false, message: "Email service is not configured." };
  }

  try {
    const draft = await createShopifyDraftOrder(
      summary.items.map((line) => ({
        quantity: line.quantity,
        variantId: line.variantId.startsWith("custom:") ? undefined : line.variantId,
        title: line.title,
        originalUnitPrice: line.unitPrice ?? line.price,
      })),
      customerEmail,
      customerName ?? "",
      session.callSid,
    );

    if (!draft.success || !draft.invoiceUrl) {
      return { ok: false, message: draft.error ?? draft.message ?? "Could not create checkout link." };
    }

    session.pendingInvoiceUrl = draft.invoiceUrl;
    session.pendingDraftOrderName = draft.draftOrderName;

    const emailResult = await sendCheckoutEmail(
      customerEmail,
      customerName ?? "",
      draft.invoiceUrl,
      summary.items,
    );

    if (!emailResult.ok) {
      return {
        ok: false,
        message: emailResult.error ?? "Could not send checkout email.",
        invoiceUrl: draft.invoiceUrl,
      };
    }

    session.paymentLinkSent = true;
    session.paymentLinkSentTo = customerEmail;
    return { ok: true, message: PAYMENT_LINK_SUCCESS_SPEECH, invoiceUrl: draft.invoiceUrl };
  } catch {
    return { ok: false, message: "Could not create checkout link." };
  }
}
