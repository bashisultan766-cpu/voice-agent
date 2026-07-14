/**
 * OrderDisclosurePolicy — field-level redaction. LLM receives OrderView DTOs only.
 */
import type { CallSession } from "../types/order.js";
import type { ActiveOrderContextData } from "./sessionManager.js";
import { canRevealOrderField, type OrderRevealField } from "./verificationGate.js";
import { filterOrderContextForVerification } from "./orderContextPrivacy.js";

export type VerificationLevel = "unverified" | "verified";

/** Immutable version tag stamped on every persisted SessionOrderContext. */
export const ORDER_DISCLOSURE_POLICY_VERSION = "order-disclosure-2026-07-14";

export interface OrderView {
  verificationLevel: VerificationLevel;
  order_number?: string;
  fulfillment_status?: string;
  financial_status?: string;
  customer_name?: string;
  items?: unknown;
  totals?: {
    subtotal?: string;
    tax?: string;
    shipping?: string;
    total?: string;
  };
  tracking_available?: boolean;
  refund_notification_email?: string;
  payment_method_last4?: string;
  card_brand?: string;
  refund_reason?: string;
  events?: unknown;
  total_order_count?: number;
  /** Never present for unverified — shipping / history stripped. */
  shipping_address?: never | string;
  past_order_history?: never | unknown;
  [key: string]: unknown;
}

const VAULT_ONLY: OrderRevealField[] = [
  "shippingAddress",
  "fullPreviousOrderHistory",
  "monthWiseOrderHistory",
  "historicalOrderDetails",
  "fullCustomerPhone",
];

export function verificationLevelFor(session: CallSession): VerificationLevel {
  return session.isVerifiedCaller === true ? "verified" : "unverified";
}

/** Build redacted OrderView — never expose raw Shopify Order/Customer to the LLM. */
export function buildOrderView(
  session: CallSession,
  context: ActiveOrderContextData | Record<string, unknown> | null | undefined,
): OrderView {
  const level = verificationLevelFor(session);
  if (!context) {
    return { verificationLevel: level };
  }

  const filtered = filterOrderContextForVerification(
    context as ActiveOrderContextData,
    level === "verified",
  ) as Record<string, unknown>;

  // Keep speech / follow-up fields that previously lived on currentOrderData.
  // Tracking digits stay on the sticky OrderView for notepad dictation; LLM
  // injection still runs redactTrackingFromOrderContext before model prompts.
  const physicalItems = filtered.physical_items ?? filtered.items;
  const trackingNumber = filtered.tracking_number as string | undefined;
  const trackingForTts = filtered.tracking_number_for_tts as string | undefined;
  const view: OrderView = {
    verificationLevel: level,
    order_number: String(filtered.order_number ?? filtered.orderNumber ?? ""),
    fulfillment_status: filtered.fulfillment_status as string | undefined,
    financial_status: filtered.financial_status as string | undefined,
    customer_name: filtered.customer_name as string | undefined,
    items: physicalItems,
    physical_items: physicalItems,
    item_count: filtered.item_count as number | undefined,
    totals: {
      subtotal: filtered.subtotal_amount as string | undefined,
      tax: filtered.total_tax as string | undefined,
      shipping: filtered.shipping_amount as string | undefined,
      total: filtered.total_amount as string | undefined,
    },
    subtotal_amount: filtered.subtotal_amount as string | undefined,
    total_tax: filtered.total_tax as string | undefined,
    shipping_amount: filtered.shipping_amount as string | undefined,
    total_amount: filtered.total_amount as string | undefined,
    tracking_available: Boolean(trackingNumber || trackingForTts),
    tracking_number: trackingNumber,
    tracking_number_for_tts: trackingForTts,
    tracking_company: filtered.tracking_company as string | undefined,
    tracking_status: filtered.tracking_status as string | undefined,
    customer_email: filtered.customer_email as string | undefined,
    order_confirmation_email: filtered.order_confirmation_email as string | undefined,
    refund_notification_email: filtered.refund_notification_email as string | undefined,
    refund_notification_email_for_tts:
      filtered.refund_notification_email_for_tts as string | undefined,
    payment_method_last4: filtered.payment_method_last4 as string | undefined,
    card_brand: filtered.card_brand as string | undefined,
    refund_reason: filtered.refund_reason as string | undefined,
    events: filtered.events,
    total_order_count: filtered.total_order_count as number | undefined,
  };

  if (level === "verified") {
    view.shipping_address = filtered.shipping_address as string | undefined;
    view.past_order_history = filtered.past_order_history;
  }

  // Strip any vault fields that slipped through for unverified.
  if (level === "unverified") {
    delete view.shipping_address;
    delete view.past_order_history;
    for (const field of VAULT_ONLY) {
      if (!canRevealOrderField(field, false)) {
        // already stripped via filterOrderContextForVerification
      }
    }
  }

  return view;
}

export const OrderDisclosurePolicy = {
  verificationLevelFor,
  buildOrderView,
} as const;
