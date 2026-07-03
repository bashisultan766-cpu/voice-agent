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
import type { EntityExtractionResult, FulfillmentIntent } from "../nlp/entityExtractor.js";
import { extractEntities } from "../nlp/entityExtractor.js";
import { fulfillmentStatusPhrase, speakMoney } from "../utils/formatter.js";

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

/** Build TTS for a successful ISBN / title book match. */
export function buildBookFoundTts(result: BookAvailabilityResult): TtsPayload {
  const name = result.bookName ?? "that book";
  const price = formatVoicePrice(result.price ?? "0");
  const stock = stockPhrase(result.inStock ?? false, result.quantity);

  return {
    text: `I found ${name}. The price is ${price}, and ${stock}. Would you like to add this to your cart?`,
    offerAddToCart: result.inStock ?? false,
    awaitingSlot: null,
  };
}

/** Build TTS for order status lookup. */
export function buildOrderStatusTts(result: OrderStatusResult): TtsPayload {
  if (result.status !== "found" || !result.orderNumber) {
    return buildOrderFallbackTts(result);
  }

  const status = fulfillmentStatusPhrase(result.fulfillmentStatus ?? "unfulfilled");
  const days = deliveryPhrase(result.estimatedDeliveryDays);
  const inTransit = /transit|shipped|deliver/i.test(result.fulfillmentStatus ?? "");

  let text = `Your order ${result.orderNumber} is currently ${status}.`;
  if (result.trackingStatus) {
    text += ` Tracking shows ${result.trackingStatus}.`;
  }
  text += inTransit
    ? ` It is expected to arrive in ${days}.`
    : ` It is expected to ship in ${days}.`;

  return { text, awaitingSlot: null };
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
  if (result.status === "throttled" || result.status === "api_error") {
    return {
      text: "I'm having trouble reaching our order system right now. Please try again in a moment.",
      awaitingSlot: "order_number",
    };
  }
  return {
    text: "I couldn't find an order with that number. Could you double-check the order number and try again?",
    awaitingSlot: "order_number",
  };
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
  if (result.status === "throttled" || result.status === "api_error") {
    return {
      text: "Our catalog system is a bit slow right now. Let me try that search again in just a second.",
      awaitingSlot: intent === "isbn_search" ? "isbn" : "title",
    };
  }
  if (intent === "isbn_search") return buildIsbnNotFoundTts();
  return buildTitleNotFoundTts();
}

function buildMissingSlotTts(extraction: EntityExtractionResult): TtsPayload {
  switch (extraction.intent) {
    case "order_status":
      return {
        text: "Please provide your order number so I can check the status.",
        awaitingSlot: "order_number",
      };
    case "isbn_search":
      return {
        text: "Please read the 10 or 13 digit ISBN from the back of the book.",
        awaitingSlot: "isbn",
      };
    case "title_search":
      return {
        text: "What is the title of the book you're looking for?",
        awaitingSlot: "title",
      };
    default:
      return {
        text: "I can help with order status, book titles, or ISBN lookups. What would you like to do?",
        awaitingSlot: null,
      };
  }
}

/**
 * Main fulfillment orchestrator — extract slots, call Shopify, return TTS.
 */
export async function handleFulfillmentTurn(
  input: FulfillmentHandlerInput,
): Promise<FulfillmentHandlerResult> {
  const callSid = input.callSid ?? "fulfillment";
  const extraction = extractEntities(input.speech, {
    awaitingSlot: input.awaitingSlot ?? undefined,
    isbnDraft: input.isbnDraft,
  });

  if (extraction.slotType === "none" || extraction.confidence < 0.5) {
    return {
      extraction,
      tts: buildMissingSlotTts(extraction),
    };
  }

  if (extraction.intent === "order_status" && extraction.orderNumber) {
    const data = await getOrderStatus(extraction.orderNumber, callSid);
    const tts =
      data.status === "found" ? buildOrderStatusTts(data) : buildOrderFallbackTts(data);
    return { extraction, tts, data };
  }

  if (extraction.intent === "isbn_search" && extraction.isbn) {
    const data = await searchByISBN(extraction.isbn, callSid);
    const tts =
      data.status === "found"
        ? buildBookFoundTts(data)
        : buildBookFallbackTts(data, "isbn_search");
    return { extraction, tts, data };
  }

  if (extraction.intent === "title_search" && extraction.title) {
    const data = await searchByTitle(extraction.title, callSid);
    const tts =
      data.status === "found"
        ? buildBookFoundTts(data)
        : buildBookFallbackTts(data, "title_search");
    return { extraction, tts, data };
  }

  return {
    extraction,
    tts: buildMissingSlotTts(extraction),
  };
}
