/**
 * Central Order Detail Builder — answers exactly what the customer requested.
 */
import type { CallSession } from "../types/order.js";
import type { ActiveOrderContextData } from "./sessionManager.js";
import { formatEmailForTTS } from "../utils/ttsFormatter.js";
import { physicalItemCount } from "../utils/productLineItems.js";
import {
  canRevealOrderField,
  maskEmailForUnverified,
  maskPhoneForUnverified,
  type OrderRevealField,
} from "./verificationGate.js";
import {
  buildUnverifiedRestrictedFieldRefusal,
  buildUnverifiedShippingAddressRefusal,
  isRestrictedFieldQueryForUnverified,
} from "./orderContextPrivacy.js";
import { armPrivateInfoBlockedEscalation } from "./supportEscalationFlow.js";

export type OrderDetailField =
  | "order_number"
  | "customer_name"
  | "product_title"
  | "quantity"
  | "item_price"
  | "subtotal"
  | "shipping_fee"
  | "total_amount"
  | "payment_gateway"
  | "payment_status"
  | "fulfillment_status"
  | "tracking_number"
  | "tracking_company"
  | "notification_email"
  | "notification_phone"
  | "shipping_address";

const FIELD_DETECTORS: Array<{ field: OrderDetailField; pattern: RegExp }> = [
  { field: "customer_name", pattern: /\b(customer\s+name|name\s+on\s+(?:the\s+)?order|who\s+ordered)\b/i },
  { field: "product_title", pattern: /\b(product\s+title|item\s+title|book\s+title|what\s+is\s+the\s+title|what'?s\s+the\s+title|which\s+books?|what\s+did\s+(?:i|you)\s+order|\btitle\b)/i },
  { field: "quantity", pattern: /\b(how many\s+(?:books|items|products)|item\s+count|quantity|number\s+of\s+(?:books|items|products))\b/i },
  { field: "item_price", pattern: /\b(product\s+amount|item\s+amount|book\s+price|(?:their|the|each)\s+price|prices?|how\s+much|\bamount\b)/i },
  { field: "subtotal", pattern: /\b(subtotal|merchandise\s+total)\b/i },
  { field: "shipping_fee", pattern: /\b(shipping\s+(?:fee|fees|cost|amount))\b/i },
  { field: "total_amount", pattern: /\b(total\s+amount|order\s+total|what\s+(?:is|was)\s+the\s+total)\b/i },
  { field: "payment_gateway", pattern: /\b(payment\s+gateway|payment\s+method|what\s+card|card\s+ending)\b/i },
  { field: "payment_status", pattern: /\b(payment\s+status|paid|unpaid|refunded)\b/i },
  { field: "fulfillment_status", pattern: /\b(order\s+status|where\s+is\s+my\s+order|fulfillment\s+status)\b/i },
  { field: "tracking_number", pattern: /\b(tracking\s+(?:id|number))\b/i },
  { field: "tracking_company", pattern: /\b(tracking\s+company|carrier|shipped\s+via)\b/i },
  { field: "notification_email", pattern: /\b(what\s+email|notification\s+email|confirmation\s+email|where\s+(?:was|is)\s+(?:the\s+)?confirmation\s+sent|notification\s+(?:sent|destination))\b/i },
  { field: "notification_phone", pattern: /\b(notification\s+phone|phone\s+on\s+(?:the\s+)?order)\b/i },
  { field: "shipping_address", pattern: /\b(shipping\s+address|delivery\s+address|where\s+(?:was|is)\s+it\s+shipped)\b/i },
];

const DETAIL_TO_REVEAL: Record<OrderDetailField, OrderRevealField> = {
  order_number: "orderNumber",
  customer_name: "customerName",
  product_title: "itemTitle",
  quantity: "itemQuantity",
  item_price: "itemPrice",
  subtotal: "subtotalAmount",
  shipping_fee: "shippingFee",
  total_amount: "totalAmount",
  payment_gateway: "paymentGateway",
  payment_status: "paymentStatus",
  fulfillment_status: "fulfillmentStatus",
  tracking_number: "trackingNumber",
  tracking_company: "trackingCompany",
  notification_email: "notificationDestinationMasked",
  notification_phone: "notificationDestinationMasked",
  shipping_address: "shippingAddress",
};

export function detectRequestedOrderFields(callerText: string): OrderDetailField[] {
  const lower = callerText.trim().toLowerCase();
  if (!lower) return [];
  const fields: OrderDetailField[] = [];
  for (const { field, pattern } of FIELD_DETECTORS) {
    if (pattern.test(lower)) fields.push(field);
  }
  return fields;
}

function physicalItems(context: ActiveOrderContextData): Array<{ title: string; quantity: number; price?: string }> {
  const raw = Array.isArray(context.physical_items)
    ? context.physical_items
    : Array.isArray(context.items)
      ? context.items
      : [];
  return (raw as any[])
    .filter((i) => String(i?.title ?? "").trim())
    .map((i) => ({
      title: String(i.title).trim(),
      quantity: Number(i.quantity ?? 1),
      price: i.price ? String(i.price).trim() : undefined,
    }));
}

function fieldSpeech(
  field: OrderDetailField,
  context: ActiveOrderContextData,
  isVerified: boolean,
): string | null {
  switch (field) {
    case "order_number": {
      const num = String(context.order_number ?? "").replace(/^#/, "").trim();
      return num ? `The order number is ${num}.` : null;
    }
    case "customer_name": {
      const name = String(context.customer_name ?? "").trim();
      return name ? `The customer name on this order is ${name}.` : null;
    }
    case "product_title": {
      const items = physicalItems(context).slice(0, 3);
      if (!items.length) return null;
      const count = physicalItemCount(items as any);
      const titles = items.map((i) => (i.quantity > 1 ? `${i.title} (qty ${i.quantity})` : i.title));
      if (titles.length === 1 && count === 1) {
        return `This order has 1 item: ${titles[0]}.`;
      }
      return `The product title${titles.length > 1 ? "s are" : " is"} ${titles.join(", ")}.`;
    }
    case "quantity": {
      const count = physicalItemCount(physicalItems(context) as any);
      return `You ordered ${count} book(s) on this order.`;
    }
    case "item_price": {
      const priced = physicalItems(context)
        .slice(0, 3)
        .map((i) => {
          if (!i.price) return i.title;
          return i.quantity > 1 ? `${i.title} (qty ${i.quantity}, ${i.price})` : `${i.title} (${i.price})`;
        });
      if (priced.length === 1 && priced[0].includes("(")) {
        const match = priced[0].match(/\(([^)]+)\)$/);
        return match ? `The item price is ${match[1].replace(/^qty \d+, /, "")}.` : `The item price is ${priced[0]}.`;
      }
      return priced.length ? `The item price${priced.length > 1 ? "s are" : " is"} ${priced.join(", ")}.` : null;
    }
    case "subtotal": {
      const sub = String(context.subtotal_amount ?? "").trim();
      return sub ? `The subtotal is ${sub}.` : null;
    }
    case "shipping_fee": {
      const ship = String(context.shipping_amount ?? "").trim();
      return ship ? `The shipping fee on this order is ${ship}.` : null;
    }
    case "total_amount": {
      const total = String(context.total_amount ?? context.subtotal_amount ?? "").trim();
      return total ? `The total order amount is ${total}.` : null;
    }
    case "payment_gateway": {
      const method = String(context.payment_method ?? context.payment_gateway ?? "").trim();
      if (!method) return null;
      if (!isVerified) {
        const gatewayOnly = method.replace(/\s+ending\s+in\s+\d{4}.*/i, "").trim();
        return gatewayOnly ? `The payment gateway is ${gatewayOnly}.` : `The payment gateway is ${method}.`;
      }
      const last4 = String(context.payment_method_last4 ?? "").trim();
      if (method && last4) return `The payment method is ${method} ending in ${last4}.`;
      return `The payment method is ${method}.`;
    }
    case "payment_status": {
      const status = String(context.financial_status ?? context.payment_status ?? "").trim();
      return status ? `The payment status is ${status}.` : null;
    }
    case "fulfillment_status": {
      const status = String(context.fulfillment_status ?? "").trim();
      return status ? `The fulfillment status is ${status}.` : null;
    }
    case "tracking_number": {
      const tracking = String(context.tracking_number ?? "").trim();
      return tracking ? `The tracking number is ${tracking}.` : null;
    }
    case "tracking_company": {
      const company = String(context.tracking_company ?? "").trim();
      return company ? `The tracking company is ${company}.` : null;
    }
    case "notification_email": {
      const raw = String(
        context.order_confirmation_email ?? context.customer_email ?? "",
      ).trim();
      if (!raw) return null;
      const spoken = formatEmailForTTS(raw) ?? raw;
      return `The notification email on this order is ${spoken}.`;
    }
    case "notification_phone": {
      const raw = String(context.customer_phone ?? context.notification_phone ?? "").trim();
      if (!raw) return null;
      return `The notification phone on this order is ${raw}.`;
    }
    case "shipping_address": {
      const address = String(context.shipping_address ?? "").trim();
      return address ? `The shipping address on file is ${address}.` : null;
    }
    default:
      return null;
  }
}

function refusalForRestrictedField(
  field: OrderDetailField,
  registeredCustomerName?: string,
): string {
  if (field === "shipping_address") {
    return buildUnverifiedShippingAddressRefusal();
  }
  return buildUnverifiedRestrictedFieldRefusal(registeredCustomerName);
}

function resolveDisclosureLabel(callerText: string): string {
  const fields = detectRequestedOrderFields(callerText);
  if (fields.length) return fields.map((f) => f.replace(/_/g, " ")).join(", ");
  return "protected order information";
}

/**
 * Build speech for exactly the fields the caller requested.
 */
export function buildOrderDetailSpeech(
  session: CallSession,
  callerText: string,
  context: ActiveOrderContextData,
): string | null {
  const verified = session.isVerifiedCaller === true;

  if (!verified && isRestrictedFieldQueryForUnverified(callerText)) {
    const registeredName = String(
      session.currentOrderData?.customer_name ?? session.currentOrder?.customerName ?? "",
    ).trim();
    if (/\b(shipping\s+address|delivery\s+address)\b/i.test(callerText)) {
      armPrivateInfoBlockedEscalation(
        session,
        "shipping address",
        "Non-verified caller requested shipping address.",
      );
      return buildUnverifiedShippingAddressRefusal();
    }
    armPrivateInfoBlockedEscalation(
      session,
      resolveDisclosureLabel(callerText),
      "Non-verified caller requested vault-protected order information.",
    );
    return buildUnverifiedRestrictedFieldRefusal(registeredName || undefined);
  }

  const fields = detectRequestedOrderFields(callerText);
  if (!fields.length) return null;

  const parts: string[] = [];

  const registeredName = String(
    session.currentOrderData?.customer_name ?? session.currentOrder?.customerName ?? "",
  ).trim();

  for (const field of fields) {
    const revealField = DETAIL_TO_REVEAL[field];
    if (!canRevealOrderField(revealField, verified)) {
      if (field === "shipping_address") {
        armPrivateInfoBlockedEscalation(
          session,
          "shipping address",
          "Non-verified caller requested shipping address.",
        );
        return buildUnverifiedShippingAddressRefusal();
      }
      armPrivateInfoBlockedEscalation(
        session,
        field.replace(/_/g, " "),
        `Non-verified caller requested ${field.replace(/_/g, " ")}.`,
      );
      return refusalForRestrictedField(field, registeredName || undefined);
    }
    const speech = fieldSpeech(field, context, verified);
    if (speech) parts.push(speech);
  }

  if (!parts.length) return null;
  return parts.join(" ");
}

