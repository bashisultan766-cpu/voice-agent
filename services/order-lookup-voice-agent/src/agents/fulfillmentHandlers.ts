/**
 * Fulfillment conversational handlers — orchestrate TTS payloads for Shoshan voice.
 *
 * Maps Shopify adapter results to caller-facing speech with graceful fallbacks
 * when lookups fail, throttle, or return no matches.
 */
import type {
  BookAvailabilityResult,
  OrderStatusResult,
} from "../adapters/shopifyStorefrontAdapter.js";
import {
  getOrderStatus,
  searchByISBN,
  searchByTitle,
} from "../adapters/shopifyStorefrontAdapter.js";
import {
  activeAgendaAwaitingSlot,
  buildAgendaPlanTts,
  buildAgendaTransitionTts,
  completeCurrentAgendaItem,
  getCurrentAgendaItem,
  getDialogueState,
  markPlanAnnounced,
  shouldAnnouncePlan,
  updateAgendaFromSpeech,
} from "./dialogueManager.js";
import type { EntityExtractionResult, FulfillmentIntent } from "../nlp/entityExtractor.js";
import {
  extractEntities,
  validateShopifyExecutionGate,
} from "../nlp/entityExtractor.js";
import {
  ORDER_NOT_FOUND_STRICT_SPOKEN,
  SYSTEM_MAINTENANCE_SPOKEN,
} from "../constants/systemMessages.js";
import {
  fulfillmentStatusPhrase,
  speakCardLast4,
  speakMoney,
} from "../utils/formatter.js";
import { logger } from "../utils/logger.js";
import type { StructuredOrder } from "../types/order.js";

export interface TtsPayload {
  text: string;
  /** Suggested next slot the agent should await from the caller. */
  awaitingSlot?: "order_number" | "title" | "isbn" | null;
  /** Whether to offer add-to-cart after a successful book match. */
  offerAddToCart?: boolean;
  endCall?: boolean;
}

export interface FulfillmentHandlerInput {
  speech: string;
  callSid?: string;
  awaitingSlot?: "order_number" | "title" | "isbn" | null;
  isbnDraft?: string;
}

export interface FulfillmentHandlerResult {
  extraction: EntityExtractionResult;
  tts: TtsPayload;
  /** Raw adapter payload when a Shopify call was made. */
  data?: OrderStatusResult | BookAvailabilityResult;
}

function formatVoicePrice(price: string): string {
  const value = Number(price);
  if (!Number.isFinite(value)) return price;
  return speakMoney(`${value.toFixed(2)} USD`);
}

function stockPhrase(inStock: boolean, quantity?: number): string {
  if (!inStock) return "it is currently out of stock";
  if (quantity !== undefined && quantity > 0) {
    return `it is currently in stock with ${quantity} available`;
  }
  return "it is currently in stock";
}

function deliveryPhrase(days: number | undefined): string {
  if (days === undefined) return "soon";
  if (days === 0) return "today or it may have already shipped";
  if (days === 1) return "1 day";
  return `${days} days`;
}

function gateAwaitingSlot(
  reason: ReturnType<typeof validateShopifyExecutionGate>["reason"],
): TtsPayload["awaitingSlot"] {
  switch (reason) {
    case "missing_order_number":
      return "order_number";
    case "missing_isbn":
      return "isbn";
    case "missing_title":
    case "vague_title":
      return "title";
    default:
      return null;
  }
}

/** Build TTS for a successful ISBN / title book match. */
export function buildBookFoundTts(result: BookAvailabilityResult): TtsPayload {
  const name = result.bookName ?? "that book";
  const price = formatVoicePrice(result.price ?? "0");
  const stock = stockPhrase(result.inStock ?? false, result.quantity);

  const lead =
    result.exactMatch === false
      ? `I couldn't find that exact title, but I found ${name}.`
      : `I found ${name}.`;

  return {
    text: `${lead} The price is ${price}, and ${stock}. Would you like to add this to your cart?`,
    offerAddToCart: result.inStock ?? false,
    awaitingSlot: null,
  };
}

function speakLineItems(lineItems: Array<{ title: string; quantity: number }>): string {
  const parts = lineItems.map((item) =>
    item.quantity > 1 ? `${item.quantity} copies of ${item.title}` : item.title,
  );
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function totalItemCount(lineItems: Array<{ title: string; quantity: number }>): number {
  return lineItems.reduce((sum, item) => sum + item.quantity, 0);
}

function isRefundedOrder(result: OrderStatusResult): boolean {
  return Boolean(result.refundStatus && /refund/i.test(result.refundStatus));
}

function speakOrderDate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return trimmed;
  return parsed.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function speakPaymentClause(result: OrderStatusResult): string | undefined {
  if (result.cardLast4?.trim()) {
    const brand = result.cardBrand?.trim();
    const last4 = speakCardLast4(result.cardLast4);
    if (brand && brand.toLowerCase() !== "card") {
      return `${brand} ending in ${last4}`;
    }
    return `a card ending in ${last4}`;
  }
  if (result.paymentGateway?.trim()) {
    return result.paymentGateway.trim();
  }
  return undefined;
}

function buildFinancialsSentence(result: OrderStatusResult): string | undefined {
  const subtotal = result.subtotalAmount?.trim();
  const shipping = result.shippingFee?.trim();
  const total = result.totalAmount?.trim();
  const payment = speakPaymentClause(result);

  if (!subtotal && !shipping && !total && !payment) return undefined;

  const parts: string[] = [];
  if (subtotal) {
    parts.push(`The subtotal was ${speakMoney(subtotal)}`);
  }
  if (shipping) {
    parts.push(`plus ${speakMoney(shipping)} for shipping`);
  }
  if (total) {
    parts.push(`making the total ${speakMoney(total)}`);
  }
  if (payment) {
    parts.push(`paid via ${payment}`);
  }

  if (parts.length === 1) return `${parts[0]}.`;
  if (parts.length === 2) return `${parts[0]}, ${parts[1]}.`;
  if (parts.length === 3) return `${parts[0]}, ${parts[1]}, ${parts[2]}.`;
  return `${parts[0]}, ${parts[1]}, ${parts[2]}, ${parts[3]}.`;
}

/**
 * Build TTS for order status — chronological story from Shopify fields only.
 * Omits any phrase when the source field is absent; never invents placeholders.
 */
export function buildOrderStatusTts(result: OrderStatusResult): TtsPayload {
  if (result.status !== "found" || !result.orderNumber) {
    return buildOrderFallbackTts(result);
  }

  logger.info("raw_data_passed_to_tts_builder", { orderData: result });

  const segments: string[] = [];

  let introduction = "I found the order";
  if (result.customerName?.trim()) {
    introduction += ` for ${result.customerName.trim()}`;
  }
  if (result.orderPlacedAt?.trim()) {
    introduction += `, placed on ${speakOrderDate(result.orderPlacedAt)}`;
  }
  introduction += ".";
  segments.push(introduction);

  if (result.lineItems?.length) {
    for (const item of result.lineItems) {
      segments.push(
        item.quantity === 1
          ? `The order contains 1 of ${item.title}.`
          : `The order contains ${item.quantity} of ${item.title}.`,
      );
    }
  } else if (result.itemCount !== undefined && result.itemCount > 0) {
    segments.push(
      result.itemCount === 1
        ? "The order contains 1 item."
        : `The order contains ${result.itemCount} items.`,
    );
  }

  const financials = buildFinancialsSentence(result);
  if (financials) segments.push(financials);

  if (isRefundedOrder(result)) {
    const refundParts: string[] = [];
    if (result.refundDate?.trim()) {
      refundParts.push(`On ${speakOrderDate(result.refundDate)}, this order was refunded.`);
    } else {
      refundParts.push("This order was refunded.");
    }
    if (result.refundReason?.trim()) {
      refundParts.push(`The reason provided was: ${result.refundReason.trim()}.`);
    }
    const refundEmail =
      result.refundNotificationEmail?.trim() ?? result.refundEmail?.trim();
    if (refundEmail) {
      refundParts.push(`A confirmation email was sent to ${refundEmail}.`);
    }
    if (result.refundAmount?.trim()) {
      refundParts.push(`The refund amount was ${speakMoney(result.refundAmount)}.`);
    }
    segments.push(refundParts.join(" "));
  } else {
    const statusParts: string[] = [];
    if (result.fulfillmentStatus?.trim()) {
      statusParts.push(
        `The order status is ${fulfillmentStatusPhrase(result.fulfillmentStatus)}.`,
      );
    }
    if (result.trackingStatus?.trim()) {
      statusParts.push(`Tracking shows ${result.trackingStatus.trim()}.`);
    }
    if (result.estimatedDeliveryDays !== undefined) {
      const eta = deliveryPhrase(result.estimatedDeliveryDays);
      const inTransit = /transit|shipped|deliver/i.test(result.fulfillmentStatus ?? "");
      statusParts.push(
        inTransit
          ? `Expected delivery is in ${eta}.`
          : `Expected to ship in ${eta}.`,
      );
    }
    if (statusParts.length) segments.push(statusParts.join(" "));
  }

  if (segments.length === 1 && segments[0] === introduction) {
    segments.push(`Order number ${result.orderNumber}.`);
  }

  return { text: segments.join(" "), awaitingSlot: null };
}

/** Map adapter order result into session StructuredOrder for follow-up context. */
export function orderStatusToStructuredOrder(
  result: OrderStatusResult,
): StructuredOrder | undefined {
  if (result.status !== "found" || !result.orderNumber) return undefined;

  const products = (result.lineItems ?? []).map((item) => ({
    name: item.title,
    quantity: item.quantity,
  }));

  return {
    orderNumber: result.orderNumber,
    customerName: result.customerName ?? "",
    productCount:
      result.itemCount ?? products.reduce((sum, item) => sum + item.quantity, 0),
    products,
    totalAmount: result.totalAmount ?? "",
    shippingFee: result.shippingFee ?? "",
    fulfillmentStatus: result.fulfillmentStatus ?? "",
    financialStatus: result.financialStatus ?? "",
    refund: {
      refunded: isRefundedOrder(result),
      reason: result.refundReason,
      refundEmail: result.refundNotificationEmail ?? result.refundEmail,
      refundAmount: result.refundAmount,
    },
    payment: {
      cardLast4: result.cardLast4,
      cardBrand: result.cardBrand,
    },
  };
}

function buildIsbnNotFoundTts(): TtsPayload {
  return {
    text: "I couldn't find a book with that ISBN. Let's try searching by the title instead. What is the name of the book?",
    awaitingSlot: "title",
  };
}

function buildTitleNotFoundTts(): TtsPayload {
  return {
    text: "I couldn't find a book matching that title in our catalog. Could you try a different title or provide the ISBN?",
    awaitingSlot: "isbn",
  };
}

function buildOrderFallbackTts(result: OrderStatusResult): TtsPayload {
  if (result.status === "invalid_format") {
    return {
      text: "I didn't catch a valid order number. Please say your order number — it's usually four to six digits.",
      awaitingSlot: "order_number",
    };
  }
  if (result.status === "throttled" || result.status === "api_error" || result.status === "system_maintenance") {
    return {
      text: SYSTEM_MAINTENANCE_SPOKEN,
      awaitingSlot: "order_number",
    };
  }
  return {
    text: ORDER_NOT_FOUND_STRICT_SPOKEN,
    awaitingSlot: "order_number",
  };
}

/** Deterministic order speech — never use LLM paraphrase for Shopify order facts. */
export function groundedOrderSpeech(result: OrderStatusResult): string {
  if (result.status === "found" && result.orderNumber) {
    return buildOrderStatusTts(result).text;
  }
  return buildOrderFallbackTts(result).text;
}

function buildBookFallbackTts(
  result: BookAvailabilityResult,
  intent: FulfillmentIntent,
): TtsPayload {
  if (result.status === "invalid_format") {
    if (intent === "isbn_search") {
      return {
        text: "I need a valid 10 or 13 digit ISBN. Could you read the ISBN on the back of the book?",
        awaitingSlot: "isbn",
      };
    }
    return {
      text: "Could you tell me the title of the book you're looking for?",
      awaitingSlot: "title",
    };
  }
  if (result.status === "throttled" || result.status === "api_error" || result.status === "system_maintenance") {
    return {
      text: "Our catalog system is a bit slow right now. Let me try that search again in just a second.",
      awaitingSlot: intent === "isbn_search" ? "isbn" : "title",
    };
  }
  if (intent === "isbn_search") return buildIsbnNotFoundTts();
  return buildTitleNotFoundTts();
}

function buildMissingSlotTts(extraction: EntityExtractionResult): TtsPayload {
  const gate = validateShopifyExecutionGate(extraction.intent, extraction);
  if (!gate.allowed) {
    return {
      text: gate.clarificationText,
      awaitingSlot: gateAwaitingSlot(gate.reason),
    };
  }

  return {
    text: "I can help with order status, book titles, or ISBN lookups. What would you like to do?",
    awaitingSlot: null,
  };
}

function resolveActiveIntent(
  extraction: EntityExtractionResult,
  agendaItem: ReturnType<typeof getCurrentAgendaItem>,
): FulfillmentIntent {
  if (agendaItem === "order_status") {
    return "order_status";
  }
  if (agendaItem === "product_search") {
    if (extraction.intent === "isbn_search") return "isbn_search";
    if (extraction.intent === "title_search") return "title_search";
    return "title_search";
  }
  return extraction.intent;
}

function appendAgendaTransition(
  tts: TtsPayload,
  callSid: string,
  orderSucceeded: boolean,
): TtsPayload {
  if (!orderSucceeded) return tts;

  const nextItem = completeCurrentAgendaItem(callSid);
  if (!nextItem) return tts;

  const bridge = buildAgendaTransitionTts(nextItem);
  return {
    ...tts,
    text: `${tts.text} ${bridge}`,
    awaitingSlot: nextItem === "product_search" ? null : "order_number",
  };
}

/**
 * Main fulfillment orchestrator — extract slots, call Shopify, return TTS.
 */
export async function handleFulfillmentTurn(
  input: FulfillmentHandlerInput,
): Promise<FulfillmentHandlerResult> {
  const callSid = input.callSid ?? "fulfillment";
  const useDialogue = callSid !== "fulfillment";

  if (useDialogue) {
    updateAgendaFromSpeech(callSid, input.speech);
  }

  if (useDialogue && shouldAnnouncePlan(callSid, input.speech)) {
    const state = getDialogueState(callSid);
    markPlanAnnounced(callSid);
    const extraction = extractEntities(input.speech, {
      awaitingSlot: input.awaitingSlot ?? undefined,
      isbnDraft: input.isbnDraft,
    });
    return {
      extraction,
      tts: {
        text: buildAgendaPlanTts(state.agenda),
        awaitingSlot: "order_number",
      },
    };
  }

  const agendaItem = useDialogue ? getCurrentAgendaItem(callSid) : null;
  const agendaAwaiting = activeAgendaAwaitingSlot(agendaItem);
  const effectiveAwaiting =
    input.awaitingSlot ?? agendaAwaiting ?? undefined;

  const extraction = extractEntities(input.speech, {
    awaitingSlot: effectiveAwaiting,
    isbnDraft: input.isbnDraft,
  });

  const activeIntent = resolveActiveIntent(extraction, agendaItem);
  const enrichedExtraction: EntityExtractionResult = {
    ...extraction,
    intent: activeIntent,
  };

  const gate = validateShopifyExecutionGate(activeIntent, enrichedExtraction);
  if (!gate.allowed) {
    return {
      extraction: enrichedExtraction,
      tts: {
        text: gate.clarificationText,
        awaitingSlot: gateAwaitingSlot(gate.reason),
      },
    };
  }

  if (activeIntent === "order_status" && enrichedExtraction.orderNumber) {
    const data = await getOrderStatus(enrichedExtraction.orderNumber, callSid);
    let tts =
      data.status === "found" ? buildOrderStatusTts(data) : buildOrderFallbackTts(data);

    if (useDialogue && data.status === "found") {
      tts = appendAgendaTransition(tts, callSid, true);
    }

    return { extraction: enrichedExtraction, tts, data };
  }

  if (activeIntent === "isbn_search" && enrichedExtraction.isbn) {
    const data = await searchByISBN(enrichedExtraction.isbn, callSid);
    const tts =
      data.status === "found"
        ? buildBookFoundTts(data)
        : buildBookFallbackTts(data, "isbn_search");
    return { extraction: enrichedExtraction, tts, data };
  }

  if (activeIntent === "title_search" && enrichedExtraction.title) {
    const data = await searchByTitle(enrichedExtraction.title, callSid);
    const tts =
      data.status === "found"
        ? buildBookFoundTts(data)
        : buildBookFallbackTts(data, "title_search");
    return { extraction: enrichedExtraction, tts, data };
  }

  return {
    extraction: enrichedExtraction,
    tts: buildMissingSlotTts(enrichedExtraction),
  };
}
