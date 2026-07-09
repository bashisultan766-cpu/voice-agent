/**
 * Central Order Detail Builder — answers exactly what the customer requested.
 */
import type { CallSession } from "../types/order.js";
import type { ActiveOrderContextData } from "./sessionManager.js";
import { formatEmailForTTS } from "../utils/ttsFormatter.js";
import { physicalItemCount } from "../utils/productLineItems.js";
import {
  isFieldDisclosureAllowed,
  resolveDisclosureFieldFromUtterance,
  shouldRefuseUnverifiedFieldQuery,
} from "./responsePolicy.js";
import { armPrivateInfoBlockedEscalation, buildUnverifiedRefusalWithSupportOffer } from "./supportEscalationFlow.js";

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
  { field: "notification_email", pattern: /\b(what\s+email|notification\s+email|confirmation\s+email|where\s+(?:was|is)\s+(?:the\s+)?confirmation\s+sent)\b/i },
  { field: "notification_phone", pattern: /\b(notification\s+phone|phone\s+on\s+(?:the\s+)?order)\b/i },
  { field: "shipping_address", pattern: /\b(shipping\s+address|delivery\s+address|where\s+(?:was|is)\s+it\s+shipped)\b/i },
];

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

function fieldSpeech(field: OrderDetailField, context: ActiveOrderContextData): string | null {
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
      const titles = items.map((i) => (i.quantity > 1 ? `${i.title} (qty ${i.quantity})` : i.title));
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
      const method = String(context.payment_method ?? "").trim();
      const last4 = String(context.payment_method_last4 ?? "").trim();
      if (method && last4) return `The payment method is ${method} ending in ${last4}.`;
      if (method) return `The payment method is ${method}.`;
      return null;
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
      const email = String(context.order_confirmation_email ?? context.customer_email ?? "").trim();
      if (!email) return null;
      const spoken = formatEmailForTTS(email) ?? email;
      return `The notification email on this order is ${spoken}.`;
    }
    case "notification_phone": {
      const phone = String(context.customer_phone ?? context.notification_phone ?? "").trim();
      return phone ? `The notification phone on this order is ${phone}.` : null;
    }
    case "shipping_address": {
      const address = String(context.shipping_address ?? "").trim();
      return address ? `The shipping address on file is ${address}.` : null;
    }
    default:
      return null;
  }
}

const FIELD_TO_POLICY: Partial<Record<OrderDetailField, import("./responsePolicy.js").OrderDisclosureField>> = {
  shipping_address: "shipping_address",
  customer_name: "customer_name",
  notification_email: "customer_email",
  notification_phone: "notification_destination",
  product_title: "line_items",
  item_price: "line_items",
  total_amount: "total_amount",
  shipping_fee: "shipping_amount",
  payment_gateway: "payment_method",
};

/**
 * Build speech for exactly the fields the caller requested.
 */
export function buildOrderDetailSpeech(
  session: CallSession,
  callerText: string,
  context: ActiveOrderContextData,
): string | null {
  const fields = detectRequestedOrderFields(callerText);
  if (!fields.length) {
    const policyField = resolveDisclosureFieldFromUtterance(callerText);
    if (!policyField) return null;
    if (shouldRefuseUnverifiedFieldQuery(session, callerText)) {
      const name = String(context.customer_name ?? "").trim();
      armPrivateInfoBlockedEscalation(
        session,
        policyField.replace(/_/g, " "),
        `Non-verified caller requested ${policyField.replace(/_/g, " ")}.`,
      );
      return buildUnverifiedRefusalWithSupportOffer(name || undefined);
    }
    return null;
  }

  const verified = session.isVerifiedCaller === true;
  const parts: string[] = [];

  for (const field of fields) {
    const policyKey = FIELD_TO_POLICY[field];
    if (policyKey && !verified && !isFieldDisclosureAllowed(session, policyKey)) {
      const name = String(context.customer_name ?? "").trim();
      armPrivateInfoBlockedEscalation(
        session,
        field.replace(/_/g, " "),
        `Non-verified caller requested ${field.replace(/_/g, " ")}.`,
      );
      return buildUnverifiedRefusalWithSupportOffer(name || undefined);
    }
    const speech = fieldSpeech(field, context);
    if (speech) parts.push(speech);
  }

  if (!parts.length) return null;
  return parts.join(" ");
}
