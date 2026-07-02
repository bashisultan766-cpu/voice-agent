/**
 * Conversation Orchestrator — Phase 1 only: intent + slot filling.
 * Shopify product APIs run exclusively via productToolPhase (Phase 2).
 */
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { extractOrderNumberFromSpeech, GOODBYE_MESSAGE } from "../utils/formatter.js";
import { orderLookupTool } from "../tools/orderLookupTool.js";
import {
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
  recordLastOrderNumber,
  recordLastProduct,
} from "../memory/callMemoryStore.js";
import { softFallback } from "./conversationBrainAgent.js";
import { formatProductResults } from "./productResponseFormatter.js";
import { extractIsbnFromSpeech } from "../tools/shopifyProductTools.js";
import {
  isPhase2Ready,
  mergeProductSlots,
  parseProductSlotsFromSpeech,
  pickProductSlotQuestion,
} from "./productSlotPhase.js";
import { executeProductSearch } from "./productToolPhase.js";
import { smoothForVoice, speechChunksFromText } from "../services/voiceSmoothingEngine.js";
import type {
  AgentStreamEvent,
  CallSession,
  OrderLookupResult,
  ProductSearchSlots,
  SpeechChunk,
  StructuredOrder,
} from "../types/order.js";

export type BrainIntent = "order_status" | "product_search" | "general_help" | "unknown";

/** @deprecated Use BrainIntent */
export type OrchestratorIntent = BrainIntent | "product_purchase_intent" | "greeting";

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

const ORDER_NUMBER_PROMPT = "Sure — please share your order number.";

const UNCLEAR_ORDER_PROMPTS = [
  "That order number looks a little short — could you read me the full number?",
  "I didn't quite get a full order number — it's usually at least four digits.",
  "Could you repeat the full order number for me?",
];

const UNKNOWN_PROMPTS = [
  "I'm here to help with book searches and order updates. What would you like to do?",
  "I can look up a book or check an order for you. Which would you prefer?",
  "Happy to help — are you browsing books or checking on an order?",
];

const GENERAL_HELP_RESPONSES = [
  "I'm here for book lookups and order updates — what can I help with?",
  "Happy to help with books or an order. What do you need?",
  "SureShot Books — I can find a title or check an order. What's on your mind?",
];

export function classifyBrainIntent(speech: string): BrainIntent {
  const text = (speech ?? "").trim();
  if (!text) return "unknown";

  const base = classifyWithRegexSync(text);
  if (base === "greeting") return "general_help";
  if (base) return base;

  return "unknown";
}

export function classifyOrchestratorIntent(speech: string): OrchestratorIntent {
  const text = (speech ?? "").trim();
  if (!text) return "unknown";

  if (/\b(buy|purchase|want to order|add to cart|checkout|place an order)\b/i.test(text)) {
    return "product_purchase_intent";
  }

  const brain = classifyBrainIntent(speech);
  if (brain === "general_help") return "greeting";
  return brain;
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

function classifyWithRegexSync(text: string): BrainIntent | "greeting" | null {
  if (extractIsbnFromSpeech(text)) return "product_search";
  if (
    /^(hi|hello|hey|howdy|good\s+(morning|afternoon|evening))[\s!.?,]*$/i.test(text) ||
    /\b(how\s+are\s+you|how'?s\s+it\s+going|what do you do|who are you|your hours)\b/i.test(text)
  ) {
    return "greeting";
  }
  if (/\b(order|tracking|track|shipment|where\s+is\s+my\s+order|my\s+order|refund)\b/i.test(text)) {
    return "order_status";
  }
  if (
    /\b(book|books|magazine|magazines|newspaper|isbn|title|do you have|looking for|i need a book)\b/i.test(
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

/** Master turn handler — Phase 1 routing; Phase 2 only when slots are ready. */
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

  if (session.phase === "awaiting_order_number" && speechContainsDigitAttempt(text)) {
    const orderNumber = extractOrderNumberFromSpeech(text);
    if (!orderNumber) {
      yield* handleUnclearOrderNumber(session);
      return;
    }
  }

  if (session.awaitingInput === "order_number") {
    yield* handleAwaitingOrderNumber(session, text);
    return;
  }

  if (
    session.awaitingInput === "product_slot" ||
    session.awaitingInput === "product_isbn" ||
    session.awaitingInput === "product_title" ||
    session.awaitingInput === "product_category"
  ) {
    yield* handleAwaitingProductSlot(session, text);
    return;
  }

  const intent = await classifyOrchestratorIntentAsync(text);
  session.lastOrchestratorIntent = intent;
  memory.inferredIntent = intent;

  logger.info("orchestrator_route", {
    callSid: session.callSid.slice(0, 8),
    intent,
    phase: session.phase,
    conversationPhase: "slot_fill",
  });

  switch (intent) {
    case "greeting":
      yield* handleGeneralHelp(session, text);
      break;
    case "order_status":
      yield* handleOrderStatus(session, text);
      break;
    case "product_search":
      yield* phase1ProductFlow(session, text);
      break;
    case "product_purchase_intent":
      yield* phase1ProductFlow(session, text);
      break;
    default:
      yield* yieldSpeech(recordAssistant(session.callSid, pickVariedLine(UNKNOWN_PROMPTS, session.callSid)));
      session.phase = "awaiting_order_number";
      yield doneEvent(session.phase);
  }
}

/** Phase 1 — merge slots, ask questions, never call Shopify. */
async function* phase1ProductFlow(
  session: CallSession,
  speech: string,
): AsyncGenerator<AgentStreamEvent> {
  const incoming = parseProductSlotsFromSpeech(speech);
  session.productSlots = mergeProductSlots(session.productSlots, incoming);

  if (isPhase2Ready(session.productSlots)) {
    yield* phase2ProductFlow(session);
    return;
  }

  session.awaitingInput = "product_slot";
  session.phase = "awaiting_order_number";
  const question = pickProductSlotQuestion(session.productSlots, "both");
  yield* yieldSpeech(recordAssistant(session.callSid, question));
  yield doneEvent(session.phase);
}

async function* handleAwaitingProductSlot(
  session: CallSession,
  speech: string,
): AsyncGenerator<AgentStreamEvent> {
  if (session.awaitingInput === "product_category") {
    const incoming = parseProductSlotsFromSpeech(speech);
    session.productSlots = mergeProductSlots(session.productSlots, incoming);
    session.awaitingInput = "product_slot";
    const question = pickProductSlotQuestion(session.productSlots, "both");
    yield* yieldSpeech(recordAssistant(session.callSid, question));
    session.phase = "awaiting_order_number";
    yield doneEvent(session.phase);
    return;
  }

  const incoming = parseProductSlotsFromSpeech(speech);
  session.productSlots = mergeProductSlots(session.productSlots, incoming);

  if (isPhase2Ready(session.productSlots)) {
    session.awaitingInput = null;
    yield* phase2ProductFlow(session);
    return;
  }

  const promptKind =
    session.awaitingInput === "product_isbn"
      ? "isbn"
      : session.awaitingInput === "product_title"
        ? "title"
        : "both";

  session.awaitingInput = "product_slot";
  session.phase = "awaiting_order_number";
  yield* yieldSpeech(
    recordAssistant(session.callSid, pickProductSlotQuestion(session.productSlots, promptKind)),
  );
  yield doneEvent(session.phase);
}

/** Phase 2 — Shopify tool execution after slots confirmed. */
async function* phase2ProductFlow(session: CallSession): AsyncGenerator<AgentStreamEvent> {
  const slots: ProductSearchSlots = { ...session.productSlots };
  const memory = getOrCreateMemory(session.callSid);
  session.productSlots = undefined;
  session.awaitingInput = null;

  logger.info("orchestrator_route", {
    callSid: session.callSid.slice(0, 8),
    conversationPhase: "tool_execute",
    hasIsbn: Boolean(slots.isbn),
    hasTitle: Boolean(slots.title),
    wantsRecommendations: Boolean(slots.wantsRecommendations),
  });

  const result = await executeProductSearch(slots, session.callSid, memory.lastProductId);
  const speech = formatProductResults(
    result.products,
    result.usedAlternatives,
    result.searchKind === "recommendations" ? "recommendations" : "search",
  );

  if (result.products[0]) {
    recordLastProduct(memory, result.products[0]);
  }

  yield* yieldSpeech(recordAssistant(session.callSid, speech));
  session.phase = "awaiting_order_number";
  yield doneEvent(session.phase);
}

async function* handleGeneralHelp(session: CallSession, speech = ""): AsyncGenerator<AgentStreamEvent> {
  session.greetedThisCall = true;
  session.phase = "awaiting_order_number";
  session.awaitingInput = null;
  const memory = getOrCreateMemory(session.callSid);

  let line: string;
  if (/\bhow\s+are\s+you\b/i.test(speech)) {
    line = pickVariedLine(HOW_ARE_YOU_RESPONSES, session.callSid);
  } else if (!speech.trim() || /^(hi|hello|hey)\b/i.test(speech.trim())) {
    line = pickVariedLine(GREETING_VARIANTS, session.callSid);
  } else {
    line = softFallback(speech);
  }

  memory.lastIntent = "general_help";
  yield* yieldSpeech(recordAssistant(session.callSid, line));
  yield doneEvent(session.phase);
}

function speechContainsDigitAttempt(speech: string): boolean {
  return (
    /\b\d+\b/.test(speech) ||
    /\b(zero|one|two|three|four|five|six|seven|eight|nine|oh)\b/i.test(speech)
  );
}

async function* handleOrderStatus(
  session: CallSession,
  speech: string,
): AsyncGenerator<AgentStreamEvent> {
  const orderNumber = extractOrderNumberFromSpeech(speech);

  if (orderNumber) {
    yield* runOrderLookup(session, orderNumber);
    return;
  }

  if (speechContainsDigitAttempt(speech)) {
    yield* handleUnclearOrderNumber(session);
    return;
  }

  session.awaitingInput = "order_number";
  session.phase = "awaiting_order_number";
  yield* yieldSpeech(recordAssistant(session.callSid, ORDER_NUMBER_PROMPT));
  yield doneEvent(session.phase);
}

async function* handleUnclearOrderNumber(session: CallSession): AsyncGenerator<AgentStreamEvent> {
  session.awaitingInput = "order_number";
  session.phase = "awaiting_order_number";
  yield* yieldSpeech(
    recordAssistant(session.callSid, pickVariedLine(UNCLEAR_ORDER_PROMPTS, session.callSid)),
  );
  yield doneEvent(session.phase);
}

async function* handleAwaitingOrderNumber(
  session: CallSession,
  speech: string,
): AsyncGenerator<AgentStreamEvent> {
  const orderNumber = extractOrderNumberFromSpeech(speech);

  if (orderNumber) {
    session.awaitingInput = null;
    yield* runOrderLookup(session, orderNumber);
    return;
  }

  if (speechContainsDigitAttempt(speech)) {
    yield* handleUnclearOrderNumber(session);
    return;
  }

  const intent = await classifyOrchestratorIntentAsync(speech);
  if (intent !== "unknown" && intent !== "order_status") {
    session.awaitingInput = null;
    switch (intent) {
      case "greeting":
        yield* handleGeneralHelp(session, speech);
        return;
      case "product_search":
        yield* phase1ProductFlow(session, speech);
        return;
      case "product_purchase_intent":
        yield* phase1ProductFlow(session, speech);
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

async function* runOrderLookup(
  session: CallSession,
  orderNumber: string,
): AsyncGenerator<AgentStreamEvent> {
  session.phase = "lookup_in_progress";
  const started = Date.now();

  yield chunkEvent(planInstantFiller());

  const lookupPromise = orderLookupTool(orderNumber);
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
    recordLastOrderNumber(getOrCreateMemory(session.callSid), orderNumber);
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
    yield* phase1ProductFlow(session, callerText);
    return;
  }
  if (route === "order_status") {
    session.phase = "awaiting_order_number";
    yield* handleOrderStatus(session, callerText);
    return;
  }
  if (route === "greeting") {
    yield* handleGeneralHelp(session, callerText);
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

// Re-export slot helpers for tests
export {
  isPhase2Ready,
  mergeProductSlots,
  parseProductSlotsFromSpeech,
  pickProductSlotQuestion,
} from "./productSlotPhase.js";
