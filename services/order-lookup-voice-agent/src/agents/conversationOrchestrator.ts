/**
 * Conversation Orchestrator — sole decision layer and Shopify execution owner.
 * streamHandler → process → gate → tools
 */
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { sanitizeForSpeech } from "../utils/security.js";
import { pipelineTrace } from "../utils/pipelineTrace.js";
import { clearCallExecutionPhase } from "../guards/toolExecutionGuard.js";
import { runWithToolAuthorizationAsync } from "../guards/toolAccessGuard.js";
import { beginOrchestratorTurn, endOrchestratorTurn, getActivePipelineCallSid } from "../guards/pipelineGuard.js";
import { clearCallMemory } from "../memory/callMemoryStore.js";
import { clearCallState, type CallState } from "../memory/callStateStore.js";
import { clearCustomerMemory } from "../memory/customerMemoryStore.js";
import { extractOrderNumberFromSpeech, GOODBYE_MESSAGE } from "../utils/formatter.js";
import { runInPhase2, setToolExecutionPhase } from "../guards/toolExecutionGuard.js";
import { orderLookupTool } from "../tools/orderLookupTool.js";
import {
  getSimilarProducts,
  searchProductByCategory,
  searchProductByISBN,
  searchProductByTitle,
} from "../tools/shopifyProductTools.js";
import { classifyFollowUpIntent, preAnalyzeOrderIntent } from "../services/llmService.js";
import { analyzeBrainTurn } from "./brainAnalyzer.js";
import {
  buildToolDecisionState,
  decideToolExecution,
  type ToolAction,
} from "./toolDecisionGate.js";
import {
  planInstantConfirmation,
  planInstantFiller,
  planLookupError,
  planOrderLookupResponse,
  planGoodbye,
  planRepeatIntro,
} from "./responsePlanner.js";
import {
  appendAssistantMessage,
  appendUserMessage,
  getOrCreateMemory,
  recordLastOrderNumber,
  recordLastProduct,
} from "../memory/callMemoryStore.js";
import {
  applyDecisionToCallState,
  atomicMergeTurnState,
  finalizeAfterToolExecution,
  getOrCreateCallState,
  isProductToolAction,
  saveCallState,
  validateProductSlotState,
} from "../memory/callStateStore.js";
import { syncSessionFromCallState } from "../memory/callStateSessionSync.js";
import { softFallback } from "./conversationBrainAgent.js";
import { formatProductResults } from "./productResponseFormatter.js";
import { extractIsbnFromSpeech, scoreTitleMatch } from "../utils/productSearchNormalize.js";
import {
  mergeProductSlots,
  parseProductSlotsFromSpeech,
  pickProductSlotQuestion,
  pickProductSlotQuestionForAwaiting,
} from "./productSlotPhase.js";
import { smoothForVoice, speechChunksFromText } from "../services/voiceSmoothingEngine.js";
import type { StructuredProduct } from "../types/product.js";
import type {
  AgentStreamEvent,
  CallSession,
  OrderLookupResult,
  ProductSearchSlots,
  SpeechChunk,
  StructuredOrder,
} from "../types/order.js";

export type BrainIntent = "order_status" | "product_search" | "general_help" | "unknown";

/** Fixed greeting spoken at call start (TwiML welcomeGreeting). */
export const BRAIN_GREETING =
  "Hi, I'm the SureShot Books Assistant. How can I help you today?";

/** Create a new call session — voice layer must not mutate slots/intent/phase. */
export function createCallSession(callSid: string, from: string, to: string): CallSession {
  return {
    callSid,
    from,
    to,
    phase: "greeting",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
    awaitingInput: null,
    greetedThisCall: false,
    productSlots: undefined,
  };
}

/** Tear down all per-call resources when the relay socket closes. */
export function endCallSession(callSid: string): void {
  clearCallMemory(callSid);
  clearCallExecutionPhase(callSid);
  clearCallState(callSid);
  clearCustomerMemory(callSid);
}

/**
 * Sole runtime entry point for user turns.
 * streamHandler → process → gate → tools
 */
export async function* process(
  callSid: string,
  userInput: string,
  session: CallSession,
): AsyncGenerator<AgentStreamEvent> {
  if (session.callSid !== callSid) {
    throw new Error(`Session callSid mismatch: ${session.callSid} !== ${callSid}`);
  }

  const text = sanitizeForSpeech((userInput ?? "").trim());
  const state = getOrCreateCallState(callSid);

  beginOrchestratorTurn(callSid);
  pipelineTrace({
    layer: "orchestrator",
    file: "conversationOrchestrator.ts",
    callSid,
    action: "turn_start",
    state: {
      intent: state.intent,
      phase: state.phase,
      awaitingInput: state.awaitingInput,
      slots: state.slots,
    },
  });

  try {
    yield* runOrchestratorTurn(session, text);
  } catch (err) {
    logger.error("orchestrator_turn_failed", {
      callSid: callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    yield {
      type: "chunk",
      chunk: {
        text: "Sorry, something went wrong on my end. Could you try that once more?",
        kind: "error",
      },
    };
    yield { type: "done", phase: session.phase };
  } finally {
    endOrchestratorTurn();
  }
}

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

const ORDER_NUMBER_PROMPT = "Sure — please tell me your order number.";

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
  const analysis = await analyzeBrainTurn(speech, {
    callSid: "sync",
    from: "",
    to: "",
    phase: "greeting",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
  });
  switch (analysis.intent) {
    case "general":
      return "greeting";
    case "order":
      return "order_status";
    case "product":
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
  const pipelineNested = getActivePipelineCallSid() === session.callSid;
  if (!pipelineNested) {
    beginOrchestratorTurn(session.callSid);
  }

  try {
    yield* runOrchestratorTurnCore(session, callerText);
  } finally {
    if (!pipelineNested) {
      endOrchestratorTurn();
    }
  }
}

async function* runOrchestratorTurnCore(
  session: CallSession,
  callerText: string,
): AsyncGenerator<AgentStreamEvent> {
  setToolExecutionPhase(session.callSid, "PHASE_1");
  const text = (callerText ?? "").trim();
  const memory = getOrCreateMemory(session.callSid);
  appendUserMessage(memory, text);

  if (session.phase === "order_disclosed" || session.phase === "follow_up") {
    yield* handleFollowUpPhase(session, text);
    return;
  }

  const callState = getOrCreateCallState(session.callSid);
  const awaitingProductSlot =
    session.awaitingInput === "product_slot" ||
    session.awaitingInput === "product_isbn" ||
    session.awaitingInput === "product_title" ||
    session.awaitingInput === "product_category" ||
    callState.awaitingInput === "isbn_or_title" ||
    callState.awaitingInput === "isbn" ||
    callState.awaitingInput === "title";

  if (
    session.phase === "awaiting_order_number" &&
    !awaitingProductSlot &&
    speechContainsDigitAttempt(text)
  ) {
    const orderNumber = extractOrderNumberFromSpeech(text);
    if (!orderNumber) {
      yield* handleUnclearOrderNumber(session);
      return;
    }
  }

  if (awaitingProductSlot) {
    yield* runGateControlledTurn(session, text, memory);
    return;
  }

  if (session.awaitingInput === "order_number") {
    yield* handleAwaitingOrderNumber(session, text);
    return;
  }

  yield* runGateControlledTurn(session, text, memory);
}

async function* runGateControlledTurn(
  session: CallSession,
  text: string,
  memory: ReturnType<typeof getOrCreateMemory>,
): AsyncGenerator<AgentStreamEvent> {
  const analysis = await analyzeBrainTurn(text, session, getOrCreateCallState(session.callSid));

  const turn = atomicMergeTurnState(session.callSid, {
    intent: analysis.intent,
    incomingSlots: analysis.slots,
    userMessage: text,
  });

  const rawDecision = decideToolExecution(
    buildToolDecisionState({
      intent: turn.state.intent,
      phase: turn.state.phase,
      awaitingInput: turn.state.awaitingInput,
      slots: turn.state.slots,
      slotsCollected: turn.slotsCollected,
      orderNumber: analysis.orderNumber,
    }),
  );

  const productToolRequested = isProductToolAction(rawDecision);
  const toolAllowed = !productToolRequested || turn.validation.ready;
  let decision = rawDecision;
  if (productToolRequested && !turn.validation.ready) {
    decision = "ASK_QUESTION";
  }

  pipelineTrace({
    layer: "orchestrator",
    file: "conversationOrchestrator.ts",
    callSid: session.callSid,
    action: "gate_decision",
    state: {
      intent: turn.state.intent,
      decision,
      rawDecision,
      toolAllowed,
      validation: turn.validation,
      slots: turn.state.slots,
    },
  });

  let nextState = applyDecisionToCallState(turn.state, decision);
  saveCallState(nextState);
  syncSessionFromCallState(session, nextState);
  setToolExecutionPhase(session.callSid, nextState.phase);
  memory.inferredIntent = turn.state.intent;

  logger.info("tool_decision_gate", {
    callSid: session.callSid.slice(0, 8),
    intent: turn.state.intent,
    decision,
    phase: nextState.phase,
    awaitingInput: nextState.awaitingInput,
    wasAwaiting: turn.wasAwaiting,
    slotsCollected: turn.slotsCollected,
    validationReady: turn.validation.ready,
    validationReason: turn.validation.reason,
    rawDecision,
    toolExecutionAllowed: toolAllowed,
    persistedIsbn: Boolean(nextState.slots.isbn),
    persistedTitle: Boolean(nextState.slots.title),
    source: analysis.source,
    confidence: analysis.confidence,
  });

  yield* executeGateDecision(session, analysis, decision, nextState, turn.slotsCollected);
}

async function* executeGateDecision(
  session: CallSession,
  analysis: Awaited<ReturnType<typeof analyzeBrainTurn>>,
  decision: ToolAction,
  callState: ReturnType<typeof getOrCreateCallState>,
  slotsCollected: boolean,
): AsyncGenerator<AgentStreamEvent> {
  if (isProductToolAction(decision)) {
    const validation = validateProductSlotState(callState, slotsCollected);
    if (!validation.ready) {
      yield* handleGateAskQuestion(session, analysis);
      return;
    }
  }

  switch (decision) {
    case "searchProductByISBN":
      session.productSlots = { isbn: callState.slots.isbn };
      yield* phase2ProductFlow(session, callState, slotsCollected);
      return;
    case "searchProductByTitle":
      session.productSlots = { title: callState.slots.title };
      yield* phase2ProductFlow(session, callState, slotsCollected);
      return;
    case "getSimilarProducts":
      session.productSlots = { wantsRecommendations: true };
      yield* phase2ProductFlow(session, callState, slotsCollected);
      return;
    case "orderLookupTool":
      if (analysis.orderNumber) {
        yield* runOrderLookup(session, analysis.orderNumber);
      }
      return;
    case "ASK_QUESTION":
      yield* handleGateAskQuestion(session, analysis);
      return;
    case "conversationOnly":
    default:
      if (analysis.intent === "general") {
        yield* handleGeneralHelp(session, analysis.userMessage);
        return;
      }
      session.phase = "awaiting_order_number";
      yield* yieldSpeech(
        recordAssistant(session.callSid, pickVariedLine(UNKNOWN_PROMPTS, session.callSid)),
      );
      yield doneEvent(session.phase);
  }
}

async function* handleGateAskQuestion(
  session: CallSession,
  analysis: Awaited<ReturnType<typeof analyzeBrainTurn>>,
): AsyncGenerator<AgentStreamEvent> {
  if (analysis.intent === "order") {
    if (speechContainsDigitAttempt(analysis.userMessage) && !analysis.orderNumber) {
      yield* handleUnclearOrderNumber(session);
      return;
    }
    session.awaitingInput = "order_number";
    session.phase = "awaiting_order_number";
    yield* yieldSpeech(recordAssistant(session.callSid, ORDER_NUMBER_PROMPT));
    yield doneEvent(session.phase);
    return;
  }

  session.phase = "awaiting_order_number";
  const callState = getOrCreateCallState(session.callSid);
  yield* yieldSpeech(
    recordAssistant(
      session.callSid,
      pickProductSlotQuestionForAwaiting(callState.awaitingInput, analysis.slots),
    ),
  );
  yield doneEvent(session.phase);
}

/** Phase 2 — Shopify tool execution after gate approval only (orchestrator-owned). */
async function* phase2ProductFlow(
  session: CallSession,
  callState: CallState,
  slotsCollected: boolean,
): AsyncGenerator<AgentStreamEvent> {
  const slots: ProductSearchSlots = { ...session.productSlots };
  const memory = getOrCreateMemory(session.callSid);
  session.productSlots = undefined;
  session.awaitingInput = null;

  assertProductSearchAllowed(callState, slots, slotsCollected);

  pipelineTrace({
    layer: "tool",
    file: "conversationOrchestrator.ts",
    callSid: session.callSid,
    action: "product_search_execute",
    state: { slots, intent: callState.intent },
  });

  const result = await runWithToolAuthorizationAsync("conversationOrchestrator", () =>
    runInPhase2(session.callSid, () =>
      orchestratorExecuteProductSearch(slots, session.callSid, memory.lastProductId),
    ),
  );
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

  const resetState = finalizeAfterToolExecution(getOrCreateCallState(session.callSid));
  saveCallState(resetState);
  syncSessionFromCallState(session, resetState);
  setToolExecutionPhase(session.callSid, "PHASE_1");

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

  session.awaitingInput = null;
  const memory = getOrCreateMemory(session.callSid);
  yield* runGateControlledTurn(session, speech, memory);
}

async function* runOrderLookup(
  session: CallSession,
  orderNumber: string,
): AsyncGenerator<AgentStreamEvent> {
  session.phase = "lookup_in_progress";
  const started = Date.now();

  yield chunkEvent(planInstantFiller());

  const lookupPromise = runWithToolAuthorizationAsync("conversationOrchestrator", () =>
    runInPhase2(session.callSid, () => orderLookupTool(orderNumber)),
  );
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

  session.phase = "awaiting_order_number";
  const memory = getOrCreateMemory(session.callSid);
  yield* runGateControlledTurn(session, callerText, memory);
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

function assertProductSearchAllowed(
  callState: CallState,
  slots: ProductSearchSlots,
  slotsCollected: boolean,
): void {
  if (callState.intent !== "product") {
    throw new Error("PRODUCT_SEARCH_BLOCKED: intent_not_product");
  }

  const hasIsbn = Boolean(slots.isbn);
  const hasTitle = Boolean(slots.title);
  const wantsRec = Boolean(slots.wantsRecommendations);

  if (!hasIsbn && !hasTitle && !wantsRec) {
    throw new Error("PRODUCT_SEARCH_BLOCKED: missing_isbn_or_title");
  }

  if (hasIsbn && !slotsCollected) {
    throw new Error("PRODUCT_SEARCH_BLOCKED: isbn_needs_slot_collection");
  }

  if (hasTitle && !hasIsbn && !slotsCollected) {
    throw new Error("PRODUCT_SEARCH_BLOCKED: title_needs_slot_collection");
  }

  if (wantsRec && !hasIsbn && !hasTitle && !slotsCollected) {
    throw new Error("PRODUCT_SEARCH_BLOCKED: recommendations_needs_slot_collection");
  }
}

const STRONG_TITLE_MATCH_SCORE = 2;

interface OrchestratorProductResult {
  products: StructuredProduct[];
  usedAlternatives: boolean;
  searchKind: "isbn" | "title" | "recommendations";
}

function isStrongTitleMatch(product: StructuredProduct, queryTitle: string): boolean {
  return scoreTitleMatch(product.title, queryTitle) >= STRONG_TITLE_MATCH_SCORE;
}

/** Shopify product search — ONLY callable from this orchestrator file. */
async function orchestratorExecuteProductSearch(
  slots: ProductSearchSlots,
  callSid: string,
  lastProductId?: string,
): Promise<OrchestratorProductResult> {
  const started = Date.now();

  if (slots.wantsRecommendations) {
    return orchestratorExecuteRecommendations(callSid, started, lastProductId);
  }

  if (slots.isbn) {
    const result = await searchProductByISBN(slots.isbn);
    if (result.products.length > 0) {
      logger.info("product_tool_isbn_hit", {
        callSid: callSid.slice(0, 8),
        isbn: slots.isbn,
        count: result.products.length,
        elapsedMs: Date.now() - started,
      });
      return { products: result.products, usedAlternatives: false, searchKind: "isbn" };
    }
    const fallback = await orchestratorFetchSimilarFallback(
      slots.title,
      lastProductId,
    );
    return { ...fallback, searchKind: "isbn" };
  }

  if (slots.title) {
    const result = await searchProductByTitle(slots.title);
    const top = result.products[0];
    if (top && isStrongTitleMatch(top, slots.title)) {
      logger.info("product_tool_title_hit", {
        callSid: callSid.slice(0, 8),
        title: slots.title,
        count: result.products.length,
        elapsedMs: Date.now() - started,
      });
      return { products: result.products, usedAlternatives: false, searchKind: "title" };
    }
    const fallback = await orchestratorFetchSimilarFallback(
      slots.title,
      lastProductId,
      top?.id,
    );
    return { ...fallback, searchKind: "title" };
  }

  return { products: [], usedAlternatives: false, searchKind: "recommendations" };
}

async function orchestratorFetchSimilarFallback(
  anchorTitle?: string,
  lastProductId?: string,
  weakCandidateId?: string,
): Promise<Omit<OrchestratorProductResult, "searchKind">> {
  if (lastProductId) {
    const similar = await getSimilarProducts(lastProductId);
    if (similar.products.length > 0) {
      return { products: similar.products.slice(0, 3), usedAlternatives: true };
    }
  }

  if (weakCandidateId) {
    const similar = await getSimilarProducts(weakCandidateId);
    if (similar.products.length > 0) {
      return { products: similar.products.slice(0, 3), usedAlternatives: true };
    }
  }

  if (anchorTitle) {
    const loose = await searchProductByTitle(anchorTitle.split(" ")[0] ?? anchorTitle);
    if (loose.products[0]) {
      const similar = await getSimilarProducts(loose.products[0].id);
      if (similar.products.length > 0) {
        return { products: similar.products.slice(0, 3), usedAlternatives: true };
      }
    }
  }

  const browse = await searchProductByCategory("books inmates");
  if (browse.products[0]) {
    const similar = await getSimilarProducts(browse.products[0].id);
    if (similar.products.length > 0) {
      return { products: similar.products.slice(0, 3), usedAlternatives: true };
    }
    return { products: browse.products.slice(0, 3), usedAlternatives: true };
  }

  return { products: [], usedAlternatives: false };
}

async function orchestratorExecuteRecommendations(
  callSid: string,
  started: number,
  lastProductId?: string,
): Promise<OrchestratorProductResult> {
  if (lastProductId) {
    const similar = await getSimilarProducts(lastProductId);
    if (similar.products.length > 0) {
      return {
        products: similar.products.slice(0, 3),
        usedAlternatives: false,
        searchKind: "recommendations",
      };
    }
  }

  const popular = await searchProductByCategory("books inmates");
  return {
    products: popular.products.slice(0, 3),
    usedAlternatives: false,
    searchKind: "recommendations",
  };
}

// Re-export slot helpers and gate for tests
export { analyzeBrainTurn } from "./brainAnalyzer.js";
export {
  buildToolDecisionState,
  decideToolExecution,
  type ToolAction,
} from "./toolDecisionGate.js";
export {
  mergeProductSlots,
  parseProductSlotsFromSpeech,
  pickProductSlotQuestion,
} from "./productSlotPhase.js";
