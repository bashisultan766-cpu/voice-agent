/**
 * Caller-ID verification — compares Twilio Caller ID to Shopify customer phone.
 */
import type { OrderStatusResult } from "../adapters/shopifyStorefrontAdapter.js";
import type { CallSession } from "../types/order.js";
import { getActiveOrderContext } from "./sessionManager.js";
import { callerMatchesAnyShopifyPhone } from "../utils/phoneNormalizer.js";
import { logger } from "../utils/logger.js";

function shopifyVerificationPhones(result: OrderStatusResult): Array<string | undefined> {
  return [result.customerPhone, result.shippingPhone, result.billingPhone];
}

export function applyCallerVerificationFromOrder(
  session: CallSession,
  result: OrderStatusResult,
): void {
  if (result.status !== "found") {
    session.isVerifiedCaller = false;
    return;
  }

  const callerPhone = session.callerPhone ?? session.from;
  session.callerPhone = callerPhone;
  session.shopifyCustomerPhone = result.customerPhone;
  session.shopifyCustomerId = result.customerId;
  session.totalOrderCount = result.totalOrderCount;

  const verificationPhones = shopifyVerificationPhones(result);
  session.isVerifiedCaller = callerMatchesAnyShopifyPhone(callerPhone, verificationPhones);

  logger.info("caller_verification_evaluated", {
    callSid: session.callSid.slice(0, 8),
    isVerifiedCaller: session.isVerifiedCaller,
    shopifyPhoneFieldCount: verificationPhones.filter((phone) => phone?.trim()).length,
  });
}

export function buildVaultSecuritySystemMessage(session: CallSession): string | null {
  if (session.isVerifiedCaller === undefined && !getActiveOrderContext(session)) {
    return null;
  }

  const customerName =
    getActiveOrderContext(session)?.customer_name ??
    session.currentOrder?.customerName ??
    "the registered customer";
  const verified = session.isVerifiedCaller === true;
  const totalOrders =
    session.totalOrderCount ??
    getActiveOrderContext(session)?.total_order_count ??
    null;

  return (
    "CRYPTOGRAPHIC IDENTITY CONTEXT (injected — follow CRYPTOGRAPHIC PRIVACY PROTOCOL): " +
    `isVerifiedCaller=${verified}; ` +
    `customer_name=${JSON.stringify(customerName)}; ` +
    `total_order_count=${totalOrders ?? "unknown"}.`
  );
}
