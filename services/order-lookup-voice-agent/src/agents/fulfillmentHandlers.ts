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

/** Build TTS for order status lookup — rich proactive summary from Shopify data. */
export function buildOrderStatusTts(result: OrderStatusResult): TtsPayload {
  if (result.status !== "found" || !result.orderNumber) {
    return buildOrderFallbackTts(result);
  }

  const parts: string[] = [];

  if (result.customerName) {
    parts.push(`I found your order under the name ${result.customerName}.`);
  } else {
    parts.push(`I found your order ${result.orderNumber}.`);
  }

  if (result.lineItems?.length) {
    parts.push(`You ordered ${speakLineItems(result.lineItems)}.`);
  } else if (result.itemCount !== undefined) {
    parts.push(
      result.itemCount === 1
        ? "It has one item."
        : `It has ${result.itemCount} items.`,
    );
  }

  if (result.subtotalAmount) {
    const subtotal = speakMoney(result.subtotalAmount);
    if (result.shippingFee) {
      const shipping = speakMoney(result.shippingFee);
      parts.push(`The books cost ${subtotal}, plus ${shipping} for shipping.`);
    } else {
      parts.push(`The books cost ${subtotal}.`);
    }
  } else if (result.totalAmount) {
    const total = speakMoney(result.totalAmount);
    if (result.shippingFee) {
      const shipping = speakMoney(result.shippingFee);
      parts.push(`The total was ${total}, including ${shipping} shipping.`);
    } else {
      parts.push(`The total was ${total}.`);
    }
  }

  if (result.refundStatus) {
    parts.push("This order has been refunded.");
    if (result.refundAmount) {
      parts.push(`The refund amount was ${speakMoney(result.refundAmount)}.`);
    }
    if (result.refundReason) {
      parts.push(`This was refunded because ${result.refundReason}.`);
    }
    const notifyEmail = result.refundNotificationEmail ?? result.refundEmail;
    if (notifyEmail) {
      parts.push(`A notification was sent to ${notifyEmail}.`);
    }
  } else {
    const status = fulfillmentStatusPhrase(result.fulfillmentStatus ?? "unfulfilled");
    parts.push(`Right now it is ${status}.`);

    if (result.trackingStatus) {
      parts.push(`Tracking shows ${result.trackingStatus}.`);
    }

    const days = deliveryPhrase(result.estimatedDeliveryDays);
    const inTransit = /transit|shipped|deliver/i.test(result.fulfillmentStatus ?? "");
    if (inTransit) {
      parts.push(`It is expected to arrive in ${days}.`);
    } else if (result.estimatedDeliveryDays !== undefined) {
      parts.push(`It is expected to ship in ${days}.`);
    }
  }

  if (result.cardLast4) {
    const brand =
      result.cardBrand && result.cardBrand !== "card" ? result.cardBrand : "your card";
    parts.push(
      `Payment was on ${brand} ending in ${speakCardLast4(result.cardLast4)}.`,
    );
  } else if (result.paymentGateway) {
    parts.push(`Payment was via ${result.paymentGateway}.`);
  }

  if (result.orderNote) {
    parts.push(`There is a note on the order: ${result.orderNote}.`);
  }

  return { text: parts.join(" "), awaitingSlot: null };
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
