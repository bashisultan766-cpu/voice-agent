/**
 * Deterministic follow-up speech for order fields — bypasses LLM when Shopify data is present.
 */
import {
  extractRefundNotificationEmailFromMessages,
  extractNotificationDeliveryFromMessages,
  formatNotificationDeliverySpeech,
} from "../adapters/orderFieldExtractors.js";
import type { CallSession } from "../types/order.js";
import type { ActiveOrderContextData } from "./sessionManager.js";
import { formatEmailForTTS } from "../utils/ttsFormatter.js";
import { physicalItemCount } from "../utils/productLineItems.js";
import { isCatalogShoppingUtterance } from "./catalogShoppingIntent.js";
import { hasConfirmedOrderContext } from "./orderContextPolicy.js";
import {
  buildUnverifiedRestrictedFieldRefusal,
  buildUnverifiedShippingAddressRefusal,
  isRestrictedFieldQueryForUnverified,
} from "./orderContextPrivacy.js";
import { maskEmailForUnverified } from "./verificationGate.js";

const REFUND_EMAIL_QUESTION_RE =
  /\b(refund(?:ed)?\s+(?:notification\s+)?email|email.*refund|refund.*email|refund.*notification|notification.*refund|where.*refund.*sent|which email.*refund|email on which)\b/i;

/** Shared patterns — callerIntent and deterministic speech use the same detector. */
export const ORDER_FIELD_QUESTION_RE =
  /\b(customer\s+name|name\s+on\s+(?:the\s+)?order|who\s+is\s+this\s+order\s+for|who\s+ordered|what\s+is\s+the\s+name|refund\s+reason|cancel\s+reason|why\s+(?:was|is)\s+(?:it|my\s+order)\s+(?:refunded|cancelled)|how\s+many\s+(?:books|items|products)|item\s+count|quantity|total\s+product|total\s+products|total\s+items|total\s+order\s+number|number\s+of\s+(?:books|items|products)|product\s+title|item\s+title|book\s+title|product\s+titles|book\s+titles|what\s+is\s+the\s+title|what'?s\s+the\s+title|product\s+amount|item\s+amount|book\s+price|(?:their|the|each)\s+price|prices?|how\s+much|total\s+amount|order\s+total|what\s+(?:is|was)\s+the\s+total|shipping\s+(?:cost|fee|fees|amount)|shipping\s+address|delivery\s+address|payment\s+method|card\s+ending|what\s+email|where\s+(?:was|is)\s+(?:the\s+)?confirmation\s+sent|confirmation\s+(?:sent|delivery)|order\s+status|where\s+is\s+my\s+order|status\s+of\s+my\s+order|order\s+details|product\s+detail|item\s+detail|tell\s+me\s+(?:the\s+)?details|tell\s+me\s+about\s+(?:the\s+)?(?:product|order|items|books)|what\s+did\s+(?:i|you)\s+order|which\s+books?)\b/i;

export function isOrderFieldQuestion(text: string, session?: CallSession): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (isCatalogShoppingUtterance(trimmed)) return false;
  if (!hasConfirmedOrderContext(session)) return false;
  return ORDER_FIELD_QUESTION_RE.test(trimmed) || isRefundNotificationEmailQuestion(trimmed);
}

const ARCHIVED_TIMELINE_MS = 365 * 24 * 60 * 60 * 1000;

function timelineMessagesFromContext(context: ActiveOrderContextData): string[] {
  const events = context.events;
  if (!Array.isArray(events)) return [];
  return events.map((entry) => String(entry).trim()).filter(Boolean);
}

function orderPlacedAtFromContext(context: ActiveOrderContextData): string | undefined {
  const raw =
    (context.order_placed_at as string | null | undefined) ??
    (context.orderPlacedAt as string | null | undefined);
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function customerEmailFromContext(context: ActiveOrderContextData): string | undefined {
  const raw =
    (context.customer_email as string | null | undefined) ??
    (context.customerEmail as string | null | undefined);
  return typeof raw === "string" && raw.includes("@") ? raw.trim() : undefined;
}

/** True when Shopify timeline events are archived (order placed more than 1 year ago). */
export function isArchivedShopifyTimelineOrder(
  orderPlacedAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!orderPlacedAt?.trim()) return false;
  const placed = new Date(orderPlacedAt);
  if (Number.isNaN(placed.getTime())) return false;
  return now.getTime() - placed.getTime() > ARCHIVED_TIMELINE_MS;
}

function yearFromOrderPlacedAt(orderPlacedAt: string): string {
  const placed = new Date(orderPlacedAt);
  if (!Number.isNaN(placed.getTime())) {
    return String(placed.getUTCFullYear());
  }
  const match = orderPlacedAt.match(/\b(20\d{2})\b/);
  return match?.[1] ?? "an earlier year";
}

/**
 * Legacy Order Fallback — archived Shopify timelines (orders > 1 year old).
 * Uses master customer_email only when refund_notification_email is unavailable.
 */
export function buildLegacyOrderRefundEmailSpeech(
  context: ActiveOrderContextData,
): string | undefined {
  const orderPlacedAt = orderPlacedAtFromContext(context);
  if (!isArchivedShopifyTimelineOrder(orderPlacedAt)) return undefined;

  const customerEmail = customerEmailFromContext(context);
  const spoken =
    (context.customer_email_for_tts as string | null | undefined)?.trim() ||
    formatEmailForTTS(customerEmail);
  if (!customerEmail || !spoken) return undefined;

  const year = yearFromOrderPlacedAt(orderPlacedAt!);
  return (
    `Because this order is from ${year}, the specific email notification logs have been securely archived by Shopify. ` +
    `However, the master contact email on file for this account is ${spoken}. ` +
    "It is highly likely the refund notification was routed there."
  );
}

/**
 * Resolve refund notification email from context fields or re-parse Shopify timeline events.
 */
export function resolveRefundNotificationEmail(
  context: ActiveOrderContextData,
): string | undefined {
  const direct =
    (context.refund_notification_email as string | null | undefined) ??
    (context.refund_email as string | null | undefined);
  if (typeof direct === "string" && direct.includes("@")) {
    return direct.trim();
  }

  return extractRefundNotificationEmailFromMessages(timelineMessagesFromContext(context));
}

/** True when the caller is asking which email received the refund notification. */
export function isRefundNotificationEmailQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (REFUND_EMAIL_QUESTION_RE.test(trimmed)) return true;

  const lower = trimmed.toLowerCase();
  const mentionsEmail = /\b(email|inbox|e-mail)\b/i.test(trimmed);
  const mentionsRefundNotice =
    /\brefund/i.test(lower) && /\b(notification|notified|notice)\b/i.test(lower);
  const mentionsWhichEmail =
    /\b(which|what)\s+email\b/i.test(lower) &&
    /\b(refund|notification|sent)\b/i.test(lower);
  const mentionsNotReceived =
    /\b(didn't|did not|never|not|haven't|have not)\s+(get|receive|got|see|find)\b/i.test(
      lower,
    ) && /\b(refund|notification)\b/i.test(lower);

  return (
    (mentionsEmail && mentionsRefundNotice) ||
    mentionsWhichEmail ||
    mentionsNotReceived
  );
}

export function isRefundNotificationDeliveryComplaint(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return (
    /\b(didn't|did not|never|not|haven't|have not)\s+(get|receive|got|see|find)\b/i.test(
      lower,
    ) &&
    /\b(refund|notification)\b/i.test(lower)
  );
}

/**
 * Grounded refund-notification email answer from ACTIVE ORDER CONTEXT.
 * Uses Shopify timeline-extracted refund_notification_email when present.
 * For archived orders (> 1 year), applies LEGACY ORDER FALLBACK with customer_email.
 */
export function buildRefundNotificationEmailSpeech(
  context: ActiveOrderContextData,
): string {
  const delivery = extractNotificationDeliveryFromMessages(timelineMessagesFromContext(context));
  if (delivery) {
    return formatNotificationDeliverySpeech(delivery);
  }

  const raw = resolveRefundNotificationEmail(context);
  const spoken = formatEmailForTTS(raw);

  if (raw && spoken) {
    return (
      `I can confirm the refund notification email was sent to ${spoken}. ` +
      "Please check your inbox and spam folder."
    );
  }

  const legacySpeech = buildLegacyOrderRefundEmailSpeech(context);
  if (legacySpeech) {
    return legacySpeech;
  }

  return (
    "I checked the official system logs for this order, but that specific detail is not on file."
  );
}

/** Same as buildRefundNotificationEmailSpeech but for callers who say they did not receive it. */
export function buildRefundNotificationComplaintSpeech(
  context: ActiveOrderContextData,
  callerText: string,
): string {
  const raw = resolveRefundNotificationEmail(context);
  const spoken = formatEmailForTTS(raw);

  if (raw && spoken) {
    return (
      `I understand you did not receive it. Our Shopify timeline shows the refund notification was sent to ${spoken}. ` +
      "Please check your inbox and spam folder at that address."
    );
  }

  const legacySpeech = buildLegacyOrderRefundEmailSpeech(context);
  if (legacySpeech) {
    return (
      `I understand you did not receive it. ${legacySpeech} ` +
      "Please check your inbox and spam folder at that address."
    );
  }

  if (isRefundNotificationDeliveryComplaint(callerText)) {
    return (
      "I checked the official system logs for this order, but the refund notification email address is not on file."
    );
  }

  return buildRefundNotificationEmailSpeech(context);
}

export function buildRefundEmailFollowUpSpeech(
  context: ActiveOrderContextData,
  callerText: string,
): string {
  if (isRefundNotificationDeliveryComplaint(callerText)) {
    return buildRefundNotificationComplaintSpeech(context, callerText);
  }
  return buildRefundNotificationEmailSpeech(context);
}

/** True when the caller asks for the name on the order. */
export function isCustomerNameQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /\b(customer\s+name|name\s+on\s+(?:the\s+)?order|who\s+is\s+this\s+order\s+for|who\s+ordered|what\s+is\s+the\s+name|what'?s\s+the\s+name)\b/i.test(
    trimmed,
  );
}

export function buildCustomerNameSpeech(
  context: ActiveOrderContextData,
  _isVerifiedCaller = true,
  _registeredCustomerName?: string,
): string | null {
  const name = String(context.customer_name ?? "").trim();
  if (!name) {
    return "I checked this order, but I do not have a customer name on file.";
  }
  return `This order is under the name ${name}.`;
}

/** Deterministic one-field answers from ACTIVE ORDER CONTEXT — null defers to LLM. */
export function buildOrderFieldQuerySpeech(
  callerText: string,
  context: ActiveOrderContextData,
  isVerifiedCaller = true,
  registeredCustomerName?: string,
): string | null {
  if (!isVerifiedCaller && isRestrictedFieldQueryForUnverified(callerText)) {
    if (/\b(shipping\s+address|delivery\s+address|where\s+(?:was|is)\s+it\s+shipped)\b/i.test(callerText)) {
      return buildUnverifiedShippingAddressRefusal();
    }
    return buildUnverifiedRestrictedFieldRefusal(registeredCustomerName);
  }

  if (isCustomerNameQuestion(callerText)) {
    return buildCustomerNameSpeech(context, isVerifiedCaller, registeredCustomerName);
  }

  if (isRefundNotificationEmailQuestion(callerText)) {
    return buildRefundEmailFollowUpSpeech(context, callerText);
  }

  const lower = callerText.trim().toLowerCase();

  if (
    /\b(all\s+(?:the\s+)?(?:order\s+)?details|tell\s+me\s+(?:all\s+)?(?:the\s+)?details|every\s+detail)\b/i.test(
      lower,
    )
  ) {
    const status = String(context.fulfillment_status ?? context.refund_status ?? "").trim();
    const name = String(context.customer_name ?? "").trim();
    const orderNum = String(context.order_number ?? "").replace(/^#/, "").trim();
    const parts: string[] = [];
    if (orderNum) parts.push(`order ${orderNum}`);
    if (status) parts.push(`status is ${status}`);
    if (name) parts.push(`under ${name.split(/\s+/)[0] ?? name}`);
    if (parts.length) {
      return `I have your ${parts.join(", ")}. Would you like the item titles, total, shipping, or tracking?`;
    }
  }

  if (/\b(shipping\s+address|delivery\s+address|where\s+(?:was|is)\s+it\s+shipped)\b/i.test(lower)) {
    if (!isVerifiedCaller) {
      return buildUnverifiedShippingAddressRefusal();
    }
    const address = String(context.shipping_address ?? "").trim();
    if (address) return `The shipping address on file is ${address}.`;
    return "I checked this order, but I do not have a shipping address on file.";
  }

  if (/\b(where\s+(?:was|is)\s+(?:the\s+)?confirmation\s+sent|confirmation\s+(?:sent|delivery))\b/i.test(lower)) {
    const email = String(
      context.order_confirmation_email ?? context.customer_email ?? "",
    ).trim();
    if (email) {
      return `The order confirmation was sent to ${formatEmailForTTS(email) ?? email}.`;
    }
    return "I checked this order, but I do not have a confirmation delivery channel on file.";
  }

  const physicalItems = Array.isArray(context.physical_items)
    ? (context.physical_items as any[])
    : Array.isArray(context.items)
      ? (context.items as any[])
      : [];
  const safeItemCount =
    typeof context.item_count === "number"
      ? (context.item_count as number)
      : physicalItemCount(physicalItems as Array<{ title: string; quantity: number }>);

  const wantsItemCount =
    /\b(how many\s+(?:books|items|products)|item\s+count|quantity|total\s+product|total\s+items|total\s+order\s+number|number\s+of\s+(?:books|items|products)|how many\s+products)\b/i.test(
      lower,
    );
  const wantsTitles =
    /\b(product\s+title|item\s+title|book\s+title|product\s+titles|book\s+titles|what\s+is\s+the\s+title|what'?s\s+the\s+title|titles?|what\s+did\s+(?:i|you)\s+order|which\s+books?|product\s+detail|item\s+detail|tell\s+me\s+about\s+(?:the\s+)?(?:product|order|items|books)|order\s+details|tell\s+me\s+(?:the\s+)?details)\b/i.test(
      lower,
    );
  const wantsLineItemAmounts =
    /\b(product\s+amount|item\s+amount|book\s+price|price\s+of|amount\s+for\s+(?:each|the\s+book)|each\s+book|per\s+book|(?:their|the|each)\s+price|prices?|how\s+much)\b/i.test(
      lower,
    );
  const wantsTotalAmount =
    /\b(total\s+amount|order\s+total|what\s+(?:is|was)\s+the\s+total|how\s+much\s+(?:was|is)\s+(?:the\s+)?order)\b/i.test(
      lower,
    );
  const wantsShipping = /\b(shipping\s+(?:fee|fees|cost)|shipping\s+amount|shipping)\b/i.test(
    lower,
  );

  const wantsAnyProductInfo =
    wantsItemCount || wantsTitles || wantsLineItemAmounts || wantsTotalAmount || wantsShipping;

  const requestedCount =
    [wantsItemCount, wantsTitles, wantsLineItemAmounts, wantsTotalAmount, wantsShipping].filter(
      Boolean,
    ).length;

  if (wantsAnyProductInfo && requestedCount === 1) {
    if (wantsItemCount) {
      return `You ordered ${safeItemCount} book(s) on this order.`;
    }
    if (wantsTitles) {
      const items = physicalItems
        .filter((i) => String(i?.title ?? "").trim())
        .slice(0, 3)
        .map((i) => {
          const title = String(i.title).trim();
          const qty = Number(i.quantity ?? 1);
          return qty > 1 ? `${title} (qty ${qty})` : title;
        });
      if (items.length > 0) {
        return `You ordered ${safeItemCount} book(s): ${items.join(", ")}.`;
      }
      return `You ordered ${safeItemCount} book(s) on this order.`;
    }
    if (wantsLineItemAmounts) {
      const priced = physicalItems
        .filter((i) => String(i?.title ?? "").trim())
        .slice(0, 3)
        .map((i) => {
          const title = String(i.title).trim();
          const qty = Number(i.quantity ?? 1);
          const price = i.price ? String(i.price).trim() : null;
          if (!price) return title;
          return qty > 1 ? `${title} (qty ${qty}, ${price})` : `${title} (${price})`;
        });
      if (priced.length > 0) return `The item amounts are: ${priced.join(", ")}.`;
    }
    if (wantsTotalAmount) {
      const total = String(context.total_amount ?? context.subtotal_amount ?? "").trim();
      if (total) return `The total order amount is ${total}.`;
    }
    if (wantsShipping) {
      const shipping = String(context.shipping_amount ?? "").trim();
      if (shipping) return `The shipping fee on this order is ${shipping}.`;
    }
  }

  if (wantsAnyProductInfo) {
    const items = physicalItems
      .filter((i) => String(i?.title ?? "").trim())
      .slice(0, 3)
      .map((i) => {
        const title = String(i.title).trim();
        const qty = Number(i.quantity ?? 1);
        const price = i.price ? String(i.price).trim() : null;
        if (wantsLineItemAmounts && price) {
          return qty > 1 ? `${title} (qty ${qty}, ${price})` : `${title} (${price})`;
        }
        return qty > 1 ? `${title} (qty ${qty})` : `${title}`;
      });

    const titlePart =
      items.length > 0 ? `You ordered ${safeItemCount} book(s): ${items.join(", ")}.` : null;

    const total = wantsTotalAmount
      ? String(context.total_amount ?? context.subtotal_amount ?? "").trim()
      : "";
    const shipping = wantsShipping ? String(context.shipping_amount ?? "").trim() : "";

    const tailParts: string[] = [];
    if (total) tailParts.push(`the total is ${total}`);
    if (shipping) tailParts.push(`shipping is ${shipping}`);

    if (titlePart) {
      if (tailParts.length) {
        return `${titlePart} ${tailParts.join(", ")}.`;
      }
      return titlePart;
    }

    if (wantsItemCount) {
      return `You ordered ${safeItemCount} book(s) on this order.`;
    }
    if (wantsTotalAmount) {
      const total = String(context.total_amount ?? context.subtotal_amount ?? "").trim();
      if (total) return `The total order amount is ${total}.`;
    }
    if (wantsShipping) {
      const shipping = String(context.shipping_amount ?? "").trim();
      if (shipping) return `The shipping fee on this order is ${shipping}.`;
    }
  }

  if (/\b(order\s+status|where\s+is\s+my\s+order|status\s+of\s+my\s+order)\b/i.test(callerText)) {
    const status = String(context.fulfillment_status ?? context.refund_status ?? "").trim();
    if (status) return `Your order status is ${status}.`;
  }

  if (/\b(refund\s+reason|cancel\s+reason|why\s+(?:was|is)\s+(?:it|my\s+order)\s+(?:refunded|cancelled))\b/i.test(callerText)) {
    const reason = String(context.cancel_reason ?? context.refund_reason ?? "").trim();
    if (reason) return `The reason on file is: ${reason}.`;
  }

  if (/\b(total\s+amount|order\s+total|how\s+much\s+(?:was|is)\s+(?:the\s+)?order)\b/i.test(callerText)) {
    const total = String(context.total_amount ?? context.subtotal_amount ?? "").trim();
    if (total) return `The total order amount is ${total}.`;
  }

  if (/\b(shipping\s+(?:fee|fees|cost)|shipping\s+amount)\b/i.test(callerText)) {
    const shipping = String(context.shipping_amount ?? "").trim();
    if (shipping) return `The shipping fee on this order is ${shipping}.`;
  }

  if (/\b(payment\s+method|what\s+card|card\s+ending)\b/i.test(callerText)) {
    if (!isVerifiedCaller) {
      return buildUnverifiedRestrictedFieldRefusal(registeredCustomerName);
    }
    const payment = String(context.payment_method ?? "").trim();
    if (payment) return `The payment method on file is ${payment}.`;
  }

  if (/\b(customer\s+email|what\s+email|email\s+on\s+(?:the\s+)?order)\b/i.test(callerText)) {
    if (!isVerifiedCaller) {
      return buildUnverifiedRestrictedFieldRefusal(registeredCustomerName);
    }
    const email = String(context.customer_email ?? context.order_confirmation_email ?? "").trim();
    if (email) {
      return `The email on this order is ${formatEmailForTTS(email) ?? email}.`;
    }
  }

  if (/\b(order\s+details|tell\s+me\s+(?:the\s+)?details|about\s+(?:my\s+)?order)\b/i.test(lower)) {
    if (!isVerifiedCaller) {
      return buildUnverifiedRestrictedFieldRefusal(registeredCustomerName);
    }
    const status = String(context.fulfillment_status ?? context.refund_status ?? "").trim();
    const name = String(context.customer_name ?? "").trim();
    const orderNum = String(context.order_number ?? "").replace(/^#/, "").trim();
    const parts: string[] = [];
    if (orderNum) parts.push(`order ${orderNum}`);
    if (status) parts.push(`status is ${status}`);
    if (name) parts.push(`under ${name.split(/\s+/)[0] ?? name}`);
    if (parts.length) {
      return `I have your ${parts.join(", ")}. Would you like the item titles, total, shipping, or tracking?`;
    }
  }

  return null;
}
