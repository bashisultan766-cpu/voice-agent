/**
 * Conversation Orchestrator — single master brain for SureShot Books voice agent.
 * Shopify + order tools are called from here; all routing and personality live here.
 */
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  extractOrderNumberFromSpeech,
  GOODBYE_MESSAGE,
} from "../utils/formatter.js";
import { lookupOrder } from "../services/shopifyService.js";
import {
  extractOrderNumberWithLlm,
  classifyFollowUpIntent,
  preAnalyzeOrderIntent,
} from "../services/llmService.js";
import {
  planInstantConfirmation,
  planInstantFiller,
  planLookupError,
  planOrderLookupResponse,
  planGoodbye,
  planRepeatIntro,
} from "./responsePlanner.js";
import { classifyCallerIntent } from "./intentClassifier.js";
import {
  appendAssistantMessage,
  appendUserMessage,
  getOrCreateMemory,
} from "../memory/callMemoryStore.js";
import {
  extractIsbnFromSpeech,
  searchProductByCategory,
  searchProductByISBN,
  searchProductByTitle,
  STORE_NOT_FOUND_MESSAGE,
} from "../tools/shopifyProductTools.js";
import { smoothForVoice, speechChunksFromText } from "../services/voiceSmoothingEngine.js";
import type {
  AgentStreamEvent,
  CallSession,
  OrderLookupResult,
  SpeechChunk,
  StructuredOrder,
} from "../types/order.js";
import type { StructuredProduct } from "../types/product.js";

export type OrchestratorIntent =
  | "greeting"
  | "order_status"
  | "product_search"
  | "product_purchase_intent"
  | "unknown";

const HOW_ARE_YOU_RESPONSES = [
  "I'm doing well, thanks for asking! How can I help you today?",
  "Doing great — appreciate you asking. What can I help you find?",
  "I'm well, thank you! Books or order status — what do you need?",
];

const GREETING_VARIANTS = [
  "Hello! I'm the Sureshot Books assistant. How can I help you today?",
  "Hi there — Sureshot Books here. What can I help you find today?",
  "Hey! Thanks for calling Sureshot Books. Are you looking for a book or checking an order?",
  "Good to hear from you. I'm here to help with books and orders — what do you need?",
];

const PRODUCT_CLARIFY_PROMPT =
  "Do you have a title or ISBN number, or are you looking for recommendations?";

const ORDER_NUMBER_PROMPT = "Sure — please share your order number.";

const PURCHASE_GUIDE_PROMPT =
  "I'd love to help you find something to order. Do you have a title or ISBN, or should I suggest popular books for inmates?";

const UNKNOWN_PROMPTS = [
  "I'm here to help with book searches and order updates. What would you like to do?",
  "I can look up a book or check an order for you. Which would you prefer?",
  "Happy to help — are you browsing books or checking on an order?",
];

const RECOMMENDATION_RE =
  /\b(recommend|suggestion|suggest|popular|what do you have|browse|inmates?|for my (son|daughter|husband|wife))\b/i;

export function classifyOrchestratorIntent(speech: string): OrchestratorIntent {
  const text = (speech ?? "").trim();
  if (!text) return "unknown";

  if (/\b(buy|purchase|want to order|add to cart|checkout|place an order)\b/i.test(text)) {
    return "product_purchase_intent";
  }

  const base = classifyWithRegexSync(text);
  if (base) return base;

  return "unknown";
}

async function classifyOrchestratorIntentAsync(speech: string): Promise<OrchestratorIntent> {
  const sync = classifyOrchestratorIntent(speech);
  if (sync !== "unknown") return sync;

  const llm = await classifyCallerIntent(speech);
  switch (llm.intent) {
    case "greeting":
      return "greeting";
    case "order_lookup":
    case "refund":
      return "order_status";
    case "product_search":
    case "isbn_query":
      return "product_search";
    default:
      return "unknown";
  }
}

function classifyWithRegexSync(text: string): OrchestratorIntent | null {
  if (extractIsbnFromSpeech(text)) return "product_search";
  if (
    /^(hi|hello|hey|howdy|good\s+(morning|afternoon|evening))[\s!.?,]*$/i.test(text) ||
    /\b(how\s+are\s+you|how'?s\s+it\s+going)\b/i.test(text)
  ) {
    return "greeting";
  }
  if (/\b(order|tracking|track|shipment|where\s+is\s+my\s+order|my\s+order|refund)\b/i.test(text)) {
    return "order_status";
  }
  if (
    /\b(book|books|magazine|magazines|newspaper|harry potter|isbn|title|do you have|looking for)\b/i.test(
      text,
    )
  ) {
    return "product_search";
  }
  return null;
}

function pickVariedLine(options: string[], callSid: string): string {
  const memory = getOrCreateMemory(callSid);
  const fresh = options.filter((line) => !memory.recentAssistantPhrases.includes(line));
  const pool = fresh.length > 0 ? fresh : options;
  return pool[Math.floor(Math.random() * pool.length)] ?? options[0];
}

function recordAssistant(callSid: string, speech: string): string {
  const memory = getOrCreateMemory(callSid);
  const smooth = smoothForVoice(speech);
  appendAssistantMessage(memory, smooth);
  return smooth;
}

function extractTitleFromSpeech(speech: string): string {
  return speech
    .replace(/\b(do you have|looking for|i want|i need|any|available|books?|magazines?|newspapers?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatProductHits(products: StructuredProduct[], usedSimilar: boolean): string {
  if (products.length === 0) {
    return STORE_NOT_FOUND_MESSAGE;
  }
  const top = products.slice(0, 3);
  const lines = top.map((p) => {
    const price = p.variants[0]?.price ?? "N/A";
    const stock = p.variants.some((v) => v.inStock) ? "in stock" : "out of stock";
    return `"${p.title}" at ${price} dollars, ${stock}`;
  });
  if (usedSimilar) {
    return `I couldn't find that exact match, but here are close options: ${lines.join("; ")}.`;
  }
  return `Yes — I found ${lines.join("; ")}.`;
}

async function searchProductsWithFallback(
  speech: string,
): Promise<{ products: StructuredProduct[]; usedSimilar: boolean }> {
  const isbn = extractIsbnFromSpeech(speech);
  if (isbn) {
    const result = await searchProductByISBN(isbn);
    if (result.products.length > 0) {
      return { products: result.products, usedSimilar: false };
    }
    const recs = await searchProductByCategory("books inmates");
    if (recs.products.length > 0) {
      return { products: recs.products, usedSimilar: true };
    }
    return { products: [], usedSimilar: false };
  }

  const title = extractTitleFromSpeech(speech) || speech.trim();
  if (title) {
    const result = await searchProductByTitle(title);
    if (result.products.length > 0) {
      return { products: result.products, usedSimilar: false };
    }
    const recs = await searchProductByCategory(`${title} books`);
    if (recs.products.length > 0) {
      return { products: recs.products, usedSimilar: true };
    }
    const broad = await searchProductByCategory("books inmates");
    if (broad.products.length > 0) {
      return { products: broad.products, usedSimilar: true };
    }
  }

  return { products: [], usedSimilar: false };
}

/** Master turn handler — sole routing brain for the voice agent. */
export async function* runOrchestratorTurn(
  session: CallSession,
  callerText: string,
): AsyncGenerator<AgentStreamEvent> {
  const text = (callerText ?? "").trim();
  const memory = getOrCreateMemory(session.callSid);
  appendUserMessage(memory, text);

  if (session.phase === "order_disclosed" || session.phase === "follow_up") {
    yield* handleFollowUpPhase(session, text);
    return;
  }

  if (session.awaitingInput === "order_number") {
    yield* handleAwaitingOrderNumber(session, text);
    return;
  }

  if (session.awaitingInput === "product_clarification") {
    yield* handleAwaitingProductClarification(session, text);
    return;
  }

  const intent = await classifyOrchestratorIntentAsync(text);
  session.lastOrchestratorIntent = intent;
  memory.inferredIntent = intent;

  logger.info("orchestrator_route", {
    callSid: session.callSid.slice(0, 8),
    intent,
    phase: session.phase,
  });

  switch (intent) {
    case "greeting":
      yield* handleGreeting(session, text);
      break;
    case "order_status":
      yield* handleOrderStatus(session, text);
      break;
    case "product_search":
      yield* handleProductSearch(session, text);
      break;
    case "product_purchase_intent":
      yield* handlePurchaseIntent(session);
      break;
    default:
      yield* yieldSpeech(recordAssistant(session.callSid, pickVariedLine(UNKNOWN_PROMPTS, session.callSid)));
      session.phase = "awaiting_order_number";
      yield doneEvent(session.phase);
  }
}

async function* handleGreeting(session: CallSession, speech = ""): AsyncGenerator<AgentStreamEvent> {
  session.greetedThisCall = true;
  session.phase = "awaiting_order_number";
  session.awaitingInput = null;
  const isHowAreYou = /\bhow\s+are\s+you\b/i.test(speech);
  const line = isHowAreYou
    ? pickVariedLine(HOW_ARE_YOU_RESPONSES, session.callSid)
    : pickVariedLine(GREETING_VARIANTS, session.callSid);
  yield* yieldSpeech(recordAssistant(session.callSid, line));
  yield doneEvent(session.phase);
}

async function* handleOrderStatus(
  session: CallSession,
  speech: string,
): AsyncGenerator<AgentStreamEvent> {
  const orderNumber =
    extractOrderNumberFromSpeech(speech) ?? (await extractOrderNumberWithLlm(speech));

  if (!orderNumber) {
    session.awaitingInput = "order_number";
    session.phase = "awaiting_order_number";
    yield* yieldSpeech(recordAssistant(session.callSid, ORDER_NUMBER_PROMPT));
    yield doneEvent(session.phase);
    return;
  }

  yield* runOrderLookup(session, orderNumber);
}

async function* handleAwaitingOrderNumber(
  session: CallSession,
  speech: string,
): AsyncGenerator<AgentStreamEvent> {
  const orderNumber =
    extractOrderNumberFromSpeech(speech) ?? (await extractOrderNumberWithLlm(speech));

  if (orderNumber) {
    session.awaitingInput = null;
    yield* runOrderLookup(session, orderNumber);
    return;
  }

  const intent = await classifyOrchestratorIntentAsync(speech);
  if (intent !== "unknown" && intent !== "order_status") {
    session.awaitingInput = null;
    switch (intent) {
      case "greeting":
        yield* handleGreeting(session, speech);
        return;
      case "product_search":
        yield* handleProductSearch(session, speech);
        return;
      case "product_purchase_intent":
        yield* handlePurchaseIntent(session);
        return;
      default:
        break;
    }
  }

  session.phase = "awaiting_order_number";
  yield* yieldSpeech(
    recordAssistant(
      session.callSid,
      "No problem — whenever you're ready, just tell me the order number.",
    ),
  );
  yield doneEvent(session.phase);
}

async function* handleProductSearch(
  session: CallSession,
  speech: string,
): AsyncGenerator<AgentStreamEvent> {
  const isbn = extractIsbnFromSpeech(speech);
  const title = extractTitleFromSpeech(speech);
  const wantsRecs = RECOMMENDATION_RE.test(speech);

  if (!isbn && !title && !wantsRecs) {
    session.awaitingInput = "product_clarification";
    session.phase = "awaiting_order_number";
    yield* yieldSpeech(recordAssistant(session.callSid, PRODUCT_CLARIFY_PROMPT));
    yield doneEvent(session.phase);
    return;
  }

  if (wantsRecs && !isbn && title.length < 4) {
    const recs = await searchProductByCategory("books inmates");
    const speech = formatProductHits(recs.products, true);
    yield* yieldSpeech(recordAssistant(session.callSid, speech));
    session.phase = "awaiting_order_number";
    yield doneEvent(session.phase);
    return;
  }

  const { products, usedSimilar } = await searchProductsWithFallback(speech);
  const speechOut = formatProductHits(products, usedSimilar);
  yield* yieldSpeech(recordAssistant(session.callSid, speechOut));
  session.phase = "awaiting_order_number";
  yield doneEvent(session.phase);
}

async function* handleAwaitingProductClarification(
  session: CallSession,
  speech: string,
): AsyncGenerator<AgentStreamEvent> {
  session.awaitingInput = null;

  if (RECOMMENDATION_RE.test(speech)) {
    const recs = await searchProductByCategory("books inmates");
    yield* yieldSpeech(
      recordAssistant(session.callSid, formatProductHits(recs.products, true)),
    );
    session.phase = "awaiting_order_number";
    yield doneEvent(session.phase);
    return;
  }

  const { products, usedSimilar } = await searchProductsWithFallback(speech);
  yield* yieldSpeech(recordAssistant(session.callSid, formatProductHits(products, usedSimilar)));
  session.phase = "awaiting_order_number";
  yield doneEvent(session.phase);
}

async function* handlePurchaseIntent(session: CallSession): AsyncGenerator<AgentStreamEvent> {
  session.awaitingInput = "product_clarification";
  session.phase = "awaiting_order_number";
  yield* yieldSpeech(recordAssistant(session.callSid, PURCHASE_GUIDE_PROMPT));
  yield doneEvent(session.phase);
}

async function* runOrderLookup(
  session: CallSession,
  orderNumber: string,
): AsyncGenerator<AgentStreamEvent> {
  session.phase = "lookup_in_progress";
  const started = Date.now();

  yield chunkEvent(planInstantFiller());

  const lookupPromise = lookupOrder(orderNumber);
  void preAnalyzeOrderIntent(orderNumber);
  const lookup = await lookupPromise;
  const lookupMs = Date.now() - started;

  logger.info("order_lookup_complete", {
    callSid: session.callSid.slice(0, 8),
    orderNumber,
    status: lookup.status,
    lookupMs,
  });

  if (lookup.status === "found") {
    yield chunkEvent(planInstantConfirmation(lookup.order));
    for (const chunk of planOrderLookupResponse(lookup.order).chunks) {
      yield { type: "chunk", chunk };
    }
    session.currentOrder = lookup.order;
    session.phase = "order_disclosed";
    session.awaitingInput = null;
    yield doneEvent(session.phase, false, lookupMs);
    return;
  }

  const errorMeta = yield* streamLookupError(session, lookup);
  yield doneEvent(session.phase, errorMeta.endCall, lookupMs);
}

async function* streamLookupError(
  session: CallSession,
  lookup: OrderLookupResult,
): AsyncGenerator<AgentStreamEvent, { endCall: boolean }> {
  const plan = planLookupError(lookup);
  for (const chunk of plan.chunks) {
    yield { type: "chunk", chunk };
  }

  if (lookup.status === "invalid_format" || lookup.status === "not_found") {
    session.orderNumberAttempts += 1;
    session.phase = "awaiting_order_number";
    session.awaitingInput = "order_number";
    if (session.orderNumberAttempts >= getConfig().ORDER_LOOKUP_MAX_RETRIES) {
      yield chunkEvent(GOODBYE_MESSAGE, "closing");
      session.phase = "ended";
      return { endCall: true };
    }
    return { endCall: false };
  }

  if (lookup.status === "api_error") {
    session.phase = "awaiting_order_number";
    session.awaitingInput = "order_number";
  }

  return { endCall: false };
}

async function* handleFollowUpPhase(
  session: CallSession,
  callerText: string,
): AsyncGenerator<AgentStreamEvent> {
  const intent = await classifyFollowUpIntent(callerText);

  if (intent === "goodbye") {
    session.phase = "ended";
    yield chunkEvent(planGoodbye());
    yield doneEvent(session.phase, true);
    return;
  }

  if (intent === "repeat_order" && session.currentOrder) {
    yield chunkEvent(planRepeatIntro());
    yield* streamOrderSummary(session.currentOrder);
    session.phase = "follow_up";
    yield doneEvent(session.phase);
    return;
  }

  const route = await classifyOrchestratorIntentAsync(callerText);
  if (route === "product_search" || route === "product_purchase_intent") {
    session.phase = "awaiting_order_number";
    yield* handleProductSearch(session, callerText);
    return;
  }
  if (route === "order_status") {
    session.phase = "awaiting_order_number";
    yield* handleOrderStatus(session, callerText);
    return;
  }
  if (route === "greeting") {
    yield* handleGreeting(session, callerText);
    return;
  }

  session.phase = "follow_up";
  yield* yieldSpeech(
    recordAssistant(
      session.callSid,
      pickVariedLine(
        [
          "What else can I help you with — another book or your order?",
          "Happy to keep helping. Books or order status?",
        ],
        session.callSid,
      ),
    ),
  );
  yield doneEvent(session.phase);
}

async function* streamOrderSummary(order: StructuredOrder): AsyncGenerator<AgentStreamEvent> {
  yield chunkEvent(planInstantConfirmation(order));
  for (const chunk of planOrderLookupResponse(order).chunks) {
    yield { type: "chunk", chunk };
  }
}

function* yieldSpeech(text: string, kind: SpeechChunk["kind"] = "summary"): Generator<AgentStreamEvent> {
  for (const chunk of speechChunksFromText(text, kind)) {
    yield { type: "chunk", chunk };
  }
}

function chunkEvent(chunk: SpeechChunk | string, kind?: SpeechChunk["kind"]): AgentStreamEvent {
  if (typeof chunk === "string") {
    return { type: "chunk", chunk: { text: chunk, kind: kind ?? "summary" } };
  }
  return { type: "chunk", chunk };
}

function doneEvent(
  phase: CallSession["phase"],
  endCall = false,
  lookupMs?: number,
): AgentStreamEvent {
  return { type: "done", phase, endCall, lookupMs };
}
