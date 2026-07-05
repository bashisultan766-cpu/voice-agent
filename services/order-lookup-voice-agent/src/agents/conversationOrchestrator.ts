/**
 * Production orchestrator — 9-step SaaS agent platform pipeline.
 *
 * 1. Event ingestion (streamHandler)
 * 2. Memory reconciliation (SessionMemory SSOT)
 * 3. Intent + context resolution
 * 4. Tool routing (deterministic only)
 * 5. Execution freeze (snapshot + turn lock)
 * 6. Tool execution (Shopify / orders, retry once)
 * 7. Validation engine (canonical identity)
 * 8. Fail-safe response engine
 * 9. Response delivery
 *
 * Self-heal layer: turnHealthMonitor + selfHealPipeline
 * streamHandler → process → gate → tools
 */
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { pipelineTrace } from "../utils/pipelineTrace.js";
import { clearCallExecutionPhase } from "../guards/toolExecutionGuard.js";
import { runWithToolAuthorizationAsync } from "../guards/toolAccessGuard.js";
import { beginOrchestratorTurn, endOrchestratorTurn, getActivePipelineCallSid } from "../guards/pipelineGuard.js";
import { clearCallMemory } from "../memory/callMemoryStore.js";
import { clearCallState, type CallState } from "../memory/callStateStore.js";
import { clearCustomerMemory } from "../memory/customerMemoryStore.js";
import { clearTurnQueue } from "../runtime/turnExecutionQueue.js";
import { clearStreamBarrier } from "../runtime/streamTurnBarrier.js";
import {
  evaluateSelfHeal,
  shouldForceRepeatSearch,
} from "../runtime/selfHealPipeline.js";
import {
  logExecutionFreeze,
  logFinalResponseType,
  logIntentDecided,
  logMemorySnapshot,
  logSelfHealTriggered,
  logToolExecutionResult,
  logToolSelected,
  logValidationResult,
  resolveExecutionFlow,
  type FinalResponseType,
} from "../runtime/turnObservability.js";
import {
  recordToolFailure,
  recordToolSuccess,
  recordValidationFailure,
  recordValidationSuccess,
  recordApiThrottleFailure,
  clearApiThrottleFailures,
  resetTurnHealth,
} from "../runtime/turnHealthMonitor.js";
import {
  getShopifyCircuitSnapshot,
  isShopifyCircuitOpen,
  isShopifyDegraded,
} from "../platform/circuitBreaker.js";
import {
  isShopifyThrottleError,
  ShopifyCircuitOpenError,
} from "../platform/shopifyErrors.js";
import { CATALOG_DEGRADED_MESSAGE } from "../constants/systemMessages.js";
import {
  beginCallTurn,
  captureCallSnapshot,
  clearCallEventSession,
  detectIsbnPartialCleared,
  dispatchAgentEvent,
  getAgentState,
} from "../platform/eventDispatcher.js";
import { pureCommitMemoryTurn } from "../platform/mergeLogic.js";
import { summarizeShopifyProducts } from "../platform/events.js";
import {
  freezeExecutionContext,
  type ExecutionContextSnapshot,
} from "../runtime/executionContextSnapshot.js";
import { clearShopifyAdapterState } from "../tools/shopifyProductAdapter.js";
import { extractOrderNumberFromSpeech, GOODBYE_MESSAGE } from "../utils/formatter.js";
import { runInPhase2, setSlotValidationReady, setToolExecutionPhase } from "../guards/toolExecutionGuard.js";
import { orderLookupTool } from "../tools/orderLookupTool.js";
import {
  getSimilarProducts,
  searchProductByCategory,
} from "../tools/shopifyProductTools.js";
import {
  searchProductByISBNIsolated,
  searchProductByTitleIsolated,
  processShopifySearchResults,
} from "../tools/shopifyProductAdapter.js";
import { classifyFollowUpIntent, preAnalyzeOrderIntent } from "../services/llmService.js";
import { analyzeBrainTurn } from "./brainAnalyzer.js";
import {
  buildToolDecisionState,
  decideToolExecution,
  decideToolExecutionWithReason,
  type GateIntent,
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
  getOrCreateMemory,
  type SessionProductMemory,
} from "../memory/callMemoryStore.js";
import {
  getOrCreateCallState,
  isProductToolAction,
  isSlotCollectedThisTurn,
  type ProductSlotValidation,
  validateProductSlotState,
} from "../memory/callStateStore.js";
import { syncSessionFromCallState } from "../memory/callStateSessionSync.js";
import { softFallback } from "./conversationBrainAgent.js";
import { formatProductResults, formatValidationFailureCandidates } from "./productResponseFormatter.js";
import {
  buildProductSearchKey,
  isExplicitRepeatRequest,
  isMemorySearchReady,
  isNewTitleSearch,
  resolveCanonicalProducts,
  normalizeProduct,
  type CanonicalProduct,
  type CanonicalResolution,
  type ProductSearchContext,
} from "./productRetrievalPolicy.js";
import { digitizeSpeechForIsbn, extractIsbnFromSpeech } from "../utils/productSearchNormalize.js";
import { clearDialogueState } from "./dialogueManager.js";
import { runLlmOrchestratorTurn } from "./llmOrchestrator.js";
import type { AgentState } from "../platform/agentState.js";
import {
  mergeProductSlots,
  parseProductSlotsFromSpeech,
  pickProductSlotQuestion,
  pickProductSlotQuestionForAwaiting,
} from "./productSlotPhase.js";
import { smoothForVoice, speechChunksFromText } from "../services/voiceSmoothingEngine.js";
import { isTrackingDictationText, sanitizeTextForTTS } from "../utils/ttsFormatter.js";
import type { StructuredProduct } from "../types/product.js";
import type {
  AgentStreamEvent,
  CallSession,
  OrderLookupResult,
  SpeechChunk,
  StructuredOrder,
} from "../types/order.js";
import { isNoiseTranscript } from "../utils/noiseGate.js";
import {
  clearCallSessionLock,
  isCallSessionActive,
  markCallSessionActive,
  markCallSessionClosed,
} from "../voice/callSessionLock.js";

export type BrainIntent = "order_status" | "product_search" | "general_help" | "unknown";

/** Fixed greeting spoken at call start (TwiML welcomeGreeting). */
export const BRAIN_GREETING =
  "Hi, I'm the SureShot Books Assistant. How can I help you today?";

/** Create a new call session — voice layer must not mutate slots/intent/phase. */
export function createCallSession(callSid: string, from: string, to: string): CallSession {
  markCallSessionActive(callSid);
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
  markCallSessionClosed(callSid);
  clearDialogueState(callSid);
  clearCallMemory(callSid);
  clearCallExecutionPhase(callSid);
  clearCallState(callSid);
  clearCustomerMemory(callSid);
  clearTurnQueue(callSid);
  clearStreamBarrier(callSid);
  clearShopifyAdapterState(callSid);
  resetTurnHealth(callSid);
  clearCallEventSession(callSid);
  clearCallSessionLock(callSid);
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

  const text = (userInput ?? "").trim();

  if (!isCallSessionActive(callSid)) {
    logger.debug("turn_dropped_call_inactive", { callSid: callSid.slice(0, 8) });
    return;
  }

  if (isNoiseTranscript(text)) {
    logger.debug("noise_gate_dropped", {
      callSid: callSid.slice(0, 8),
      textLength: text.length,
      preview: text.slice(0, 12),
    });
    return;
  }

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
    recordToolFailure(callSid);
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
    emitResponseSent(
      callSid,
      "error",
      "Sorry, something went wrong on my end. Could you try that once more?",
    );
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

function recordAssistant(_callSid: string, speech: string): string {
  return smoothForVoice(speech);
}

/** Phase 2: user utterance enters state only via TURN_INGESTED → reducer. */
function ingestUserTurn(callSid: string, text: string): number {
  const turnSeq = beginCallTurn(callSid);
  dispatchAgentEvent(
    callSid,
    {
      type: "TURN_INGESTED",
      payload: {
        textLength: text.length,
        source: "orchestrator",
        partial: false,
        textPreview: text.slice(0, 120),
        userMessage: text,
      },
    },
    { turnSeq },
  );
  return turnSeq;
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
  setSlotValidationReady(session.callSid, false);
  const text = (callerText ?? "").trim();
  ingestUserTurn(session.callSid, text);

  if (session.phase === "order_disclosed" || session.phase === "follow_up") {
    yield* handleFollowUpPhase(session, text);
    return;
  }

  yield* runLlmOrchestratorTurn(session, text, emitResponseSent);
}

function isExecutableToolAction(decision: string): boolean {
  return isProductToolAction(decision) || decision === "orderLookupTool";
}

async function* runGateControlledTurn(
  session: CallSession,
  text: string,
  memory: ReturnType<typeof getOrCreateMemory>,
): AsyncGenerator<AgentStreamEvent> {
  const analysis = await analyzeBrainTurn(text, session, getOrCreateCallState(session.callSid));

  const snapshotBeforeCommit = captureCallSnapshot(session.callSid);
  const wasAwaiting = getOrCreateCallState(session.callSid).awaitingInput;
  const memoryCommitTimestamp = Date.now();

  const previewTurn = pureCommitMemoryTurn(getAgentState(session.callSid), {
    intent: analysis.intent,
    incomingSlots: analysis.deltaSlots,
    userMessage: text,
  });

  const previewAfterSnapshot = {
    product: previewTurn.productMemory,
    callState: {
      intent: previewTurn.callStateSlice.intent,
      phase: previewTurn.callStateSlice.phase,
      awaitingInput: previewTurn.callStateSlice.awaitingInput,
      slots: previewTurn.callStateSlice.slots,
      slotFlags: previewTurn.callStateSlice.slotFlags,
    },
  };

  const healEval = evaluateSelfHeal(session.callSid, text, previewTurn.productMemory, {
    callSid: session.callSid,
    ...previewTurn.callStateSlice,
  } as CallState);

  dispatchAgentEvent(
    session.callSid,
    {
      type: "MEMORY_SYNCD",
      payload: {
        mergeInput: {
          intent: analysis.intent,
          incomingSlots: analysis.deltaSlots,
          userMessage: text,
        },
        searchKey: buildProductSearchKey(previewTurn.productMemory),
        explicitRepeat:
          isExplicitRepeatRequest(text) || shouldForceRepeatSearch(healEval),
        syncLog: previewTurn.syncLog,
        isbnPartialCleared: detectIsbnPartialCleared(
          snapshotBeforeCommit,
          previewAfterSnapshot,
        ),
        selfHealApplied: false,
        memoryCommitTimestamp,
      },
    },
    { memoryBefore: snapshotBeforeCommit },
  );

  if (healEval.shouldHeal && !healEval.blockRepeatSearch) {
    logSelfHealTriggered(session.callSid, healEval.reasons);
    logger.info("self_heal_pipeline_restart", {
      callSid: session.callSid.slice(0, 8),
      reasons: healEval.reasons,
    });
    clearShopifyAdapterState(session.callSid);
    dispatchAgentEvent(session.callSid, {
      type: "MEMORY_SYNCD",
      payload: { selfHealResync: true, selfHealApplied: true },
    });
  }

  const agentState = getAgentState(session.callSid);
  const productMemory = agentState.product;
  const turnState = getOrCreateCallState(session.callSid);
  const turn = {
    state: turnState,
    wasAwaiting,
    slotsCollected: isSlotCollectedThisTurn(wasAwaiting, turnState),
    validation: validateProductSlotState(turnState, productMemory),
    productMemory,
    syncLog: previewTurn.syncLog,
    memoryCommitTimestamp,
  };

  const explicitRepeat =
    !healEval.blockRepeatSearch &&
    (isExplicitRepeatRequest(text) || shouldForceRepeatSearch(healEval));
  const searchKey = buildProductSearchKey(productMemory);

  if (turn.syncLog) {
    logger.info("slot_to_memory_sync", {
      callSid: session.callSid.slice(0, 8),
      ...turn.syncLog,
    });
  }

  logMemorySnapshot(session.callSid, productMemory, {
    memoryCommitTs: turn.memoryCommitTimestamp,
    explicitRepeat,
    searchKey,
  });

  logIntentDecided(session.callSid, {
    intent: turn.state.intent,
    flow: resolveExecutionFlow(
      turn.state.intent,
      analysis.orderNumber,
      isMemorySearchReady(productMemory),
    ),
    source: analysis.source,
    orderNumber: analysis.orderNumber,
    explicitRepeat,
  });

  if (turn.syncLog) {
    logger.info("slot_to_memory_sync", {
      callSid: session.callSid.slice(0, 8),
      ...turn.syncLog,
    });
  }

  logger.info("search_key_computed", {
    callSid: session.callSid.slice(0, 8),
    searchKey,
    explicitRepeat,
  });

  if (turn.wasAwaiting === "isbn") {
    logger.info("isbn_slot_parse_attempt", {
      callSid: session.callSid.slice(0, 8),
      transcript: text,
      digitized: digitizeSpeechForIsbn(text),
      isbn: productMemory.isbn,
      isbnCollected: productMemory.isbnCollected,
      validationReady: turn.validation.ready,
    });
  }

  const gateResult = decideToolExecutionWithReason(
    buildToolDecisionState({
      intent: turn.state.intent,
      phase: turn.state.phase,
      awaitingInput: turn.state.awaitingInput,
      productMemory,
      validationReady: turn.validation.ready,
      explicitRepeat,
      wantsRecommendations: Boolean(turn.state.slots.wantsRecommendations),
      orderNumber: analysis.orderNumber,
    }),
  );

  logToolSelected(session.callSid, {
    tool: gateResult.action,
    reason: gateResult.reason,
    searchKey,
    validationReady: turn.validation.ready,
  });

  logger.info("tool_execution_reason", {
    callSid: session.callSid.slice(0, 8),
    action: gateResult.action,
    reason: gateResult.reason,
    searchKey,
  });

  const rawDecision = gateResult.action;

  const validationReady = turn.validation.ready;
  const toolExecutionAllowed = validationReady;
  const finalDecision: "ALLOW_TOOL" | "BLOCK_TOOL" =
    validationReady && isExecutableToolAction(rawDecision) ? "ALLOW_TOOL" : "BLOCK_TOOL";

  let decision = rawDecision;
  if (!validationReady && isExecutableToolAction(rawDecision)) {
    decision = "ASK_QUESTION";
  } else if (
    decision === "ASK_QUESTION" &&
    turn.state.intent === "product" &&
    isMemorySearchReady(productMemory)
  ) {
    decision = decideToolExecution(
      buildToolDecisionState({
        intent: turn.state.intent,
        phase: turn.state.phase,
        awaitingInput: turn.state.awaitingInput,
        productMemory,
        validationReady: true,
        explicitRepeat,
        wantsRecommendations: Boolean(turn.state.slots.wantsRecommendations),
        orderNumber: analysis.orderNumber,
      }),
    );
  }

  pipelineTrace({
    layer: "orchestrator",
    file: "conversationOrchestrator.ts",
    callSid: session.callSid,
    action: "gate_decision",
    validationReady,
    toolExecutionAllowed,
    finalDecision,
    state: {
      intent: turn.state.intent,
      decision,
      rawDecision,
      validation: turn.validation,
      slots: turn.state.slots,
    },
  });

  dispatchAgentEvent(session.callSid, {
    type: "TOOL_SELECTED",
    payload: {
      tool: gateResult.action,
      reason: gateResult.reason,
      searchKey,
      validationReady: turn.validation.ready,
      intent: turn.state.intent,
      flow: resolveExecutionFlow(
        turn.state.intent,
        analysis.orderNumber,
        isMemorySearchReady(productMemory),
      ),
      gateDecision: decision,
    },
  });

  const nextState = getOrCreateCallState(session.callSid);
  syncSessionFromCallState(session, nextState);

  setSlotValidationReady(session.callSid, validationReady);
  setToolExecutionPhase(
    session.callSid,
    validationReady && isExecutableToolAction(decision) ? "PHASE_2" : "PHASE_1",
  );

  logger.info("tool_decision_gate", {
    callSid: session.callSid.slice(0, 8),
    intent: turn.state.intent,
    decision,
    phase: nextState.phase,
    awaitingInput: nextState.awaitingInput,
    wasAwaiting: turn.wasAwaiting,
    slotsCollected: turn.slotsCollected,
    isbnCollected: productMemory.isbnCollected,
    titleCollected: productMemory.titleCollected,
    validationReady: turn.validation.ready,
    validationReason: turn.validation.reason,
    rawDecision,
    toolExecutionAllowed,
    finalDecision,
    persistedIsbn: Boolean(productMemory.isbn),
    persistedTitle: Boolean(productMemory.title),
    searchKey,
    toolReason: gateResult.reason,
    source: analysis.source,
  });

  yield* executeGateDecision(session, analysis, decision, nextState, turn.validation, text, productMemory);
}

async function* executeGateDecision(
  session: CallSession,
  analysis: Awaited<ReturnType<typeof analyzeBrainTurn>>,
  decision: ToolAction,
  callState: ReturnType<typeof getOrCreateCallState>,
  validation: ProductSlotValidation,
  userMessage: string,
  productMemory: ReturnType<typeof getOrCreateMemory>["product"],
): AsyncGenerator<AgentStreamEvent> {
  if (isExecutableToolAction(decision) && !validation.ready) {
    yield* handleGateAskQuestion(session, analysis, userMessage);
    return;
  }

  switch (decision) {
    case "searchProductByISBN":
      session.productSlots = { isbn: productMemory.isbn };
      yield* phase2ProductFlow(session, callState, userMessage, productMemory);
      return;
    case "searchProductByTitle":
      session.productSlots = { title: productMemory.title };
      yield* phase2ProductFlow(session, callState, userMessage, productMemory);
      return;
    case "getSimilarProducts":
      session.productSlots = { wantsRecommendations: true };
      yield* phase2ProductFlow(session, callState, userMessage, productMemory);
      return;
    case "orderLookupTool":
      if (analysis.orderNumber) {
        yield* runOrderLookup(session, analysis.orderNumber);
      }
      return;
    case "ASK_QUESTION":
      yield* handleGateAskQuestion(session, analysis, userMessage);
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
  userMessage: string,
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
  const memory = getOrCreateMemory(session.callSid);
  if (analysis.intent === "product" && isMemorySearchReady(memory.product)) {
    const explicitRepeat = isExplicitRepeatRequest(userMessage);
    const searchDecision = decideToolExecution(
      buildToolDecisionState({
        intent: callState.intent,
        phase: callState.phase,
        awaitingInput: callState.awaitingInput,
        productMemory: memory.product,
        validationReady: true,
        explicitRepeat,
        wantsRecommendations: Boolean(callState.slots.wantsRecommendations),
        orderNumber: analysis.orderNumber,
      }),
    );
    if (isProductToolAction(searchDecision) || searchDecision === "orderLookupTool") {
      yield* executeGateDecision(
        session,
        analysis,
        searchDecision,
        callState,
        { ready: true },
        userMessage,
        memory.product,
      );
      return;
    }
  }

  const clarificationSpeech = pickProductSlotQuestionForAwaiting(
    callState.awaitingInput,
    callState.slots,
    callState.slotFlags,
  );
  yield* yieldSpeech(recordAssistant(session.callSid, clarificationSpeech));
  emitResponseSent(session.callSid, "clarification_question", clarificationSpeech, {
    awaiting: callState.awaitingInput,
  });
  yield doneEvent(session.phase);
}

/** Phase 2 — Shopify tool execution after gate approval only (orchestrator-owned). */
async function* phase2ProductFlow(
  session: CallSession,
  callState: CallState,
  userMessage: string,
  productMemory: ReturnType<typeof getOrCreateMemory>["product"],
): AsyncGenerator<AgentStreamEvent> {
  const memory = getOrCreateMemory(session.callSid);
  session.productSlots = undefined;
  session.awaitingInput = null;

  assertProductSearchAllowed(callState, productMemory);

  setSlotValidationReady(session.callSid, true);
  setToolExecutionPhase(session.callSid, "PHASE_2");

  const explicitRepeat = isExplicitRepeatRequest(userMessage);
  const searchKey = buildProductSearchKey(productMemory) ?? "unknown";

  const executionSnapshot = freezeExecutionContext({
    callSid: session.callSid,
    memory: productMemory,
    slots: callState.slots,
    explicitRepeat,
    wantsRecommendations: Boolean(callState.slots.wantsRecommendations),
  });

  logExecutionFreeze(session.callSid, {
    frozenAt: executionSnapshot.frozenAt,
    searchKey: executionSnapshot.searchKey,
  });

  dispatchAgentEvent(
    session.callSid,
    {
      type: "EXECUTION_FROZEN",
      payload: {
        frozenAt: executionSnapshot.frozenAt,
        searchKey: executionSnapshot.searchKey,
        explicitRepeat,
      },
    },
    { memoryAfter: captureCallSnapshot(session.callSid) },
  );

  logger.info("execution_context_frozen", {
    callSid: session.callSid.slice(0, 8),
    frozenAt: executionSnapshot.frozenAt,
    searchKey: executionSnapshot.searchKey,
    explicitRepeat,
  });

  pipelineTrace({
    layer: "tool",
    file: "conversationOrchestrator.ts",
    callSid: session.callSid,
    action: "product_search_execute",
    validationReady: true,
    toolExecutionAllowed: true,
    finalDecision: "ALLOW_TOOL",
    includeStack: true,
    state: { productMemory, intent: callState.intent, searchKey, frozenAt: executionSnapshot.frozenAt },
  });

  if (isShopifyCircuitOpen()) {
    yield* yieldDegradedCatalogResponse(session, "product_search", "CIRCUIT_OPEN");
    return;
  }

  let result: OrchestratorProductResult;
  try {
    result = await runWithToolAuthorizationAsync("conversationOrchestrator", () =>
      runInPhase2(session.callSid, () =>
        orchestratorExecuteProductSearch(executionSnapshot, false),
      ),
    );
  } catch (err) {
    if (isShopifyThrottleError(err)) {
      yield* yieldDegradedCatalogResponse(
        session,
        "product_search",
        err instanceof ShopifyCircuitOpenError ? "CIRCUIT_OPEN" : "THROTTLED",
      );
      return;
    }
    throw err;
  }

  if (result.infrastructureFailure) {
    yield* yieldDegradedCatalogResponse(
      session,
      "product_search",
      result.infrastructureReason ?? "THROTTLED",
    );
    return;
  }

  const candidatePool = [...result.canonicalCandidates];

  if (result.resolution?.shouldRetry && !isShopifyDegraded()) {
    logger.info("retry_reason_if_any", {
      callSid: session.callSid.slice(0, 8),
      reason: result.resolution.rejected[0]?.reason,
      strictRetry: true,
    });
    try {
      const retryResult = await runWithToolAuthorizationAsync("conversationOrchestrator", () =>
        runInPhase2(session.callSid, () =>
          orchestratorExecuteProductSearch(executionSnapshot, true),
        ),
      );
      if (!retryResult.infrastructureFailure) {
        candidatePool.push(...retryResult.canonicalCandidates);
        result = retryResult;
      }
    } catch (err) {
      if (!isShopifyThrottleError(err)) throw err;
      logger.warn("shopify_strict_retry_skipped_throttle", {
        callSid: session.callSid.slice(0, 8),
      });
    }
  }

  const failSafeCandidates = dedupeCanonicalCandidates(candidatePool).slice(0, 2);
  const executedSearchKey = result.executedSearchKey ?? searchKey;
  const acceptedCount = result.resolution?.accepted.length ?? 0;
  const hasConfirmedProduct = acceptedCount === 1 && Boolean(result.products[0]);

  logger.info("final_validation_decision", {
    callSid: session.callSid.slice(0, 8),
    accepted: acceptedCount,
    hasConfirmedProduct,
    failSafeCandidates: failSafeCandidates.length,
    searchKind: result.searchKind,
  });

  let speech: string;
  let responseType: FinalResponseType;
  if (hasConfirmedProduct) {
    const responseMode =
      result.searchKind === "recommendations"
        ? "recommendations"
        : result.ambiguousTitle
          ? "ambiguous"
          : "search";

    speech = formatProductResults(
      result.products,
      result.usedAlternatives,
      responseMode,
    );
    responseType =
      result.searchKind === "recommendations"
        ? "confirmed_product"
        : result.ambiguousTitle
          ? "fail_safe_alternatives"
          : "confirmed_product";
  } else if (failSafeCandidates.length > 0 && result.searchKind !== "recommendations") {
    speech = formatValidationFailureCandidates(failSafeCandidates);
    responseType = "fail_safe_alternatives";
  } else {
    speech = formatProductResults(result.products, result.usedAlternatives, "search");
    responseType = "not_found";
  }

  emitResponseSent(session.callSid, responseType, speech, {
    searchKind: result.searchKind,
    acceptedCount,
    failSafeCandidates: failSafeCandidates.length,
    finalizeToolExecution: true,
  });

  if (hasConfirmedProduct && result.products[0]) {
    recordValidationSuccess(session.callSid);
    recordToolSuccess(session.callSid);
    clearApiThrottleFailures(session.callSid);
  } else if (result.searchKind !== "recommendations" && !result.infrastructureFailure) {
    recordValidationFailure(session.callSid);
    if (result.resolution?.rejected.some((r) => r.reason.includes("mismatch"))) {
      recordToolFailure(session.callSid);
    }
  }

  yield* yieldSpeech(recordAssistant(session.callSid, speech));
  session.phase = "awaiting_order_number";

  syncSessionFromCallState(session, getOrCreateCallState(session.callSid));
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

  yield* yieldSpeech(recordAssistant(session.callSid, line));
  emitResponseSent(session.callSid, "general_help", line);
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

  setSlotValidationReady(session.callSid, true);
  setToolExecutionPhase(session.callSid, "PHASE_2");

  dispatchAgentEvent(session.callSid, {
    type: "TOOL_EXECUTION_STARTED",
    payload: { tool: "searchOrderById" },
  });

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

  const orderToolStatus =
    lookup.status === "found"
      ? "found"
      : lookup.status === "api_error"
        ? "error"
        : "not_found";

  dispatchAgentEvent(
    session.callSid,
    {
      type: "TOOL_EXECUTION_COMPLETED",
      payload: {
        tool: "searchOrderById",
        status: orderToolStatus,
        resultCount: lookup.status === "found" ? 1 : 0,
        elapsedMs: lookupMs,
        orderStatus: lookup.status,
      },
    },
    { latencyMs: lookupMs },
  );

  if (lookup.status === "found") {
    recordToolSuccess(session.callSid);
    yield chunkEvent(planInstantConfirmation(lookup.order));
    for (const chunk of planOrderLookupResponse(lookup.order).chunks) {
      yield { type: "chunk", chunk };
    }
    session.currentOrder = lookup.order;
    session.phase = "order_disclosed";
    session.awaitingInput = null;
    logToolExecutionResult(session.callSid, {
      tool: "searchOrderById",
      status: "found",
      resultCount: 1,
      elapsedMs: lookupMs,
    });
    emitResponseSent(session.callSid, "order_found", "", {
      orderNumber,
      recordOrderNumber: orderNumber,
    });
    yield doneEvent(session.phase, false, lookupMs);
    return;
  }

  logToolExecutionResult(session.callSid, {
    tool: "searchOrderById",
    status: lookup.status === "api_error" ? "error" : "not_found",
    resultCount: 0,
    elapsedMs: lookupMs,
  });

  const errorMeta = yield* streamLookupError(session, lookup);
  if (lookup.status === "api_error") {
    recordToolFailure(session.callSid);
    emitResponseSent(session.callSid, "order_api_error", "", { orderNumber });
  } else {
    emitResponseSent(session.callSid, "order_not_found", "", { orderNumber });
  }
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
  yield* runLlmOrchestratorTurn(session, callerText, emitResponseSent);
}

async function* streamOrderSummary(order: StructuredOrder): AsyncGenerator<AgentStreamEvent> {
  yield chunkEvent(planInstantConfirmation(order));
  for (const chunk of planOrderLookupResponse(order).chunks) {
    yield { type: "chunk", chunk };
  }
}

function* yieldSpeech(text: string, kind: SpeechChunk["kind"] = "summary"): Generator<AgentStreamEvent> {
  const sanitized = sanitizeTextForTTS(text);
  const resolvedKind = isTrackingDictationText(sanitized) ? ("dictation" as const) : kind;
  for (const chunk of speechChunksFromText(sanitized, resolvedKind, {
    preserveFull: resolvedKind === "dictation",
  })) {
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
  productMemory: SessionProductMemory,
): void {
  if (callState.intent !== "product") {
    throw new Error("PRODUCT_SEARCH_BLOCKED: intent_not_product");
  }

  const hasIsbn = Boolean(productMemory.isbn);
  const hasTitle = Boolean(productMemory.title);
  const wantsRec = Boolean(callState.slots.wantsRecommendations);

  if (!hasIsbn && !hasTitle && !wantsRec) {
    throw new Error("PRODUCT_SEARCH_BLOCKED: missing_isbn_or_title");
  }

  if (hasIsbn && !productMemory.isbnCollected) {
    throw new Error("PRODUCT_SEARCH_BLOCKED: isbn_needs_slot_collection");
  }

  if (hasTitle && !hasIsbn && !productMemory.titleCollected) {
    throw new Error("PRODUCT_SEARCH_BLOCKED: title_needs_slot_collection");
  }

  if (wantsRec && !hasIsbn && !hasTitle && !callState.slotFlags.recommendationsCollected) {
    throw new Error("PRODUCT_SEARCH_BLOCKED: recommendations_needs_slot_collection");
  }
}

interface OrchestratorProductResult {
  products: StructuredProduct[];
  canonicalCandidates: CanonicalProduct[];
  resolution: CanonicalResolution | null;
  usedAlternatives: boolean;
  searchKind: "isbn" | "title" | "recommendations";
  ambiguousTitle?: boolean;
  validationFailed?: boolean;
  executedSearchKey?: string;
  infrastructureFailure?: boolean;
  infrastructureReason?: "THROTTLED" | "CIRCUIT_OPEN";
}

function emitDegradedMode(
  callSid: string,
  reason: "THROTTLED" | "CIRCUIT_OPEN" | "API_TIMEOUT",
  operation: string,
): void {
  const snap = getShopifyCircuitSnapshot();
  dispatchAgentEvent(callSid, {
    type: "DEGRADED_MODE",
    payload: {
      reason,
      retryAfterMs: snap.retryAfterMs,
      operation,
      circuitState: snap.state === "HALF_OPEN" ? "HALF_OPEN" : snap.state === "OPEN" ? "OPEN" : undefined,
    },
  });
}

async function* yieldDegradedCatalogResponse(
  session: CallSession,
  operation: string,
  reason: "THROTTLED" | "CIRCUIT_OPEN",
): AsyncGenerator<AgentStreamEvent> {
  recordApiThrottleFailure(session.callSid);
  emitDegradedMode(session.callSid, reason, operation);
  const speech = CATALOG_DEGRADED_MESSAGE;
  yield* yieldSpeech(recordAssistant(session.callSid, speech));
  emitResponseSent(session.callSid, "catalog_degraded", speech, { finalizeToolExecution: true });
  session.phase = "awaiting_order_number";
  syncSessionFromCallState(session, getOrCreateCallState(session.callSid));
  setToolExecutionPhase(session.callSid, "PHASE_1");
  yield doneEvent(session.phase);
}

function dedupeCanonicalCandidates(candidates: CanonicalProduct[]): CanonicalProduct[] {
  const seen = new Set<string>();
  const out: CanonicalProduct[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    out.push(candidate);
  }
  return out;
}

/** Dual-write RESPONSE_SENT alongside legacy turnObservability final_response_type log. */
function emitResponseSent(
  callSid: string,
  responseType: FinalResponseType,
  speech: string,
  meta?: Record<string, unknown>,
): void {
  logFinalResponseType(callSid, responseType, meta);
  dispatchAgentEvent(callSid, {
    type: "RESPONSE_SENT",
    payload: {
      responseType,
      speechLength: speech.length,
      speech: speech || undefined,
      searchKind: typeof meta?.searchKind === "string" ? meta.searchKind : undefined,
      finalizeToolExecution: meta?.finalizeToolExecution === true,
      recordOrderNumber:
        typeof meta?.recordOrderNumber === "string" ? meta.recordOrderNumber : undefined,
      recordProduct:
        meta?.recordProduct &&
        typeof meta.recordProduct === "object" &&
        "id" in meta.recordProduct &&
        "title" in meta.recordProduct
          ? (meta.recordProduct as { id: string; title: string; searchKey?: string })
          : undefined,
      fulfillmentAwaitingSlot:
        meta?.fulfillmentAwaitingSlot === "order_number" ||
        meta?.fulfillmentAwaitingSlot === "title" ||
        meta?.fulfillmentAwaitingSlot === "isbn"
          ? meta.fulfillmentAwaitingSlot
          : undefined,
      fulfillmentFlow: meta?.fulfillmentFlow === true ? true : undefined,
    },
  });
}

function logCanonicalResolution(
  callSid: string,
  stage: string,
  resolution: CanonicalResolution,
  strictRetry?: boolean,
): void {
  logger.info("product_validation_stage", {
    callSid: callSid.slice(0, 8),
    stage,
    candidateCount: resolution.candidates.length,
    acceptedCount: resolution.accepted.length,
    rejectedReasons: resolution.rejected.map((row) => row.reason),
  });
  logValidationResult(callSid, {
    accepted: resolution.accepted.length,
    rejected: resolution.rejected.length,
    passed: resolution.accepted.length === 1,
    reasons: resolution.rejected.map((row) => row.reason),
    strictRetry,
  });
  dispatchAgentEvent(callSid, {
    type: "VALIDATION_RESULT",
    payload: {
      accepted: resolution.accepted.length,
      rejected: resolution.rejected.length,
      passed: resolution.accepted.length === 1,
      reasons: resolution.rejected.map((row) => row.reason),
      strictRetry,
      stage,
    },
  });
}

function buildCanonicalResult(
  resolution: CanonicalResolution,
  searchKind: "isbn" | "title" | "recommendations",
  executedSearchKey: string,
  usedAlternatives = false,
): OrchestratorProductResult {
  const acceptedProducts = resolution.accepted.map((row) => row.raw);
  return {
    products: acceptedProducts,
    canonicalCandidates: resolution.candidates,
    resolution,
    usedAlternatives,
    searchKind,
    ambiguousTitle: acceptedProducts.length > 1,
    validationFailed: resolution.validationFailed,
    executedSearchKey,
  };
}

/** Shopify → normalize → sanitize → validateCanonicalProduct (frozen snapshot only). */
async function orchestratorExecuteProductSearch(
  snapshot: ExecutionContextSnapshot,
  strictRetry: boolean,
): Promise<OrchestratorProductResult> {
  const { memory: productMemory, callSid, explicitRepeat, searchKey } = snapshot;
  const started = Date.now();
  const executedSearchKey = searchKey ?? "unknown";

  const context: ProductSearchContext = {
    memory: productMemory,
    explicitRepeat,
    forceFreshTitleQuery: Boolean(
      productMemory.title && searchKey && isNewTitleSearch(productMemory, searchKey),
    ),
    wantsRecommendations: snapshot.wantsRecommendations,
  };

  const excludeProductId =
    strictRetry || (!explicitRepeat && productMemory.lastResultProductId)
      ? productMemory.lastResultProductId
      : undefined;

  if (context.wantsRecommendations) {
    const recTool = explicitRepeat && productMemory.lastResultProductId
      ? "getSimilarProducts"
      : "searchProductByCategory";
    dispatchAgentEvent(callSid, {
      type: "TOOL_EXECUTION_STARTED",
      payload: { tool: recTool, searchKey: executedSearchKey, strictRetry },
    });
    const rec = await orchestratorExecuteRecommendations(
      callSid,
      started,
      explicitRepeat ? productMemory.lastResultProductId : undefined,
    );
    const recElapsed = Date.now() - started;
    dispatchAgentEvent(
      callSid,
      {
        type: "TOOL_EXECUTION_COMPLETED",
        payload: {
          tool: recTool,
          status: rec.products.length > 0 ? "found" : "not_found",
          resultCount: rec.products.length,
          elapsedMs: recElapsed,
          strictRetry,
          products: summarizeShopifyProducts(rec.products),
        },
      },
      { latencyMs: recElapsed },
    );
    return {
      ...rec,
      canonicalCandidates: rec.products.map((p) =>
        normalizeProduct(p, executedSearchKey, { title: productMemory.title }),
      ),
      resolution: null,
      executedSearchKey,
    };
  }

  if (productMemory.isbn && productMemory.isbnCollected) {
    dispatchAgentEvent(callSid, {
      type: "TOOL_EXECUTION_STARTED",
      payload: {
        tool: "searchProductByISBN",
        searchKey: executedSearchKey,
        strictRetry,
        excludeProductId,
      },
    });
    const raw = await searchProductByISBNIsolated(callSid, productMemory.isbn, {
      excludeProductId,
    });
    const isbnElapsed = Date.now() - started;
    dispatchAgentEvent(
      callSid,
      {
        type: "TOOL_EXECUTION_COMPLETED",
        payload: {
          tool: "searchProductByISBN",
          status: raw.products.length ? "found" : "not_found",
          resultCount: raw.products.length,
          elapsedMs: isbnElapsed,
          strictRetry,
          products: summarizeShopifyProducts(raw.products),
        },
      },
      { latencyMs: isbnElapsed },
    );
    const canonical = processShopifySearchResults(
      raw.products,
      executedSearchKey,
      { isbn: productMemory.isbn },
      callSid,
    );
    const resolution = resolveCanonicalProducts(
      canonical,
      productMemory,
      explicitRepeat,
      executedSearchKey,
    );
    logCanonicalResolution(callSid, strictRetry ? "post_retry_isbn" : "post_normalize_isbn", resolution, strictRetry);
    logToolExecutionResult(callSid, {
      tool: "searchProductByISBN",
      status: raw.products.length ? "found" : "not_found",
      resultCount: raw.products.length,
      elapsedMs: Date.now() - started,
      strictRetry,
    });

    if (resolution.accepted.length > 0) {
      logger.info("product_tool_isbn_hit", {
        callSid: callSid.slice(0, 8),
        isbn: productMemory.isbn,
        count: resolution.accepted.length,
        elapsedMs: Date.now() - started,
        strictRetry,
      });
      return buildCanonicalResult(resolution, "isbn", executedSearchKey);
    }

    return {
      products: [],
      canonicalCandidates: canonical,
      resolution,
      usedAlternatives: false,
      searchKind: "isbn",
      validationFailed: resolution.validationFailed || canonical.length > 0,
      executedSearchKey,
    };
  }

  if (productMemory.title && productMemory.titleCollected) {
    dispatchAgentEvent(callSid, {
      type: "TOOL_EXECUTION_STARTED",
      payload: {
        tool: "searchProductByTitle",
        searchKey: executedSearchKey,
        strictRetry,
        excludeProductId,
      },
    });
    const raw = await searchProductByTitleIsolated(callSid, productMemory.title, {
      excludeProductId,
      strictExactOnly: strictRetry,
    });
    const titleElapsed = Date.now() - started;
    dispatchAgentEvent(
      callSid,
      {
        type: "TOOL_EXECUTION_COMPLETED",
        payload: {
          tool: "searchProductByTitle",
          status: raw.products.length ? "found" : "not_found",
          resultCount: raw.products.length,
          elapsedMs: titleElapsed,
          strictRetry,
          products: summarizeShopifyProducts(raw.products),
        },
      },
      { latencyMs: titleElapsed },
    );
    const canonical = processShopifySearchResults(
      raw.products,
      executedSearchKey,
      { title: productMemory.title },
      callSid,
    );
    const resolution = resolveCanonicalProducts(
      canonical,
      productMemory,
      explicitRepeat,
      executedSearchKey,
    );
    logCanonicalResolution(callSid, strictRetry ? "post_retry_title" : "post_normalize_title", resolution, strictRetry);
    logToolExecutionResult(callSid, {
      tool: "searchProductByTitle",
      status: raw.products.length ? "found" : "not_found",
      resultCount: raw.products.length,
      elapsedMs: Date.now() - started,
      strictRetry,
    });

    if (resolution.accepted.length > 0) {
      return buildCanonicalResult(
        resolution,
        "title",
        executedSearchKey,
        resolution.accepted.length > 1,
      );
    }

    return {
      products: [],
      canonicalCandidates: canonical,
      resolution,
      usedAlternatives: false,
      searchKind: "title",
      validationFailed: resolution.validationFailed || canonical.length > 0,
      executedSearchKey,
    };
  }

  return {
    products: [],
    canonicalCandidates: [],
    resolution: null,
    usedAlternatives: false,
    searchKind: "recommendations",
    executedSearchKey,
  };
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
        canonicalCandidates: [],
        resolution: null,
      };
    }
  }

  const popular = await searchProductByCategory("books inmates");
  return {
    products: popular.products.slice(0, 3),
    usedAlternatives: false,
    searchKind: "recommendations",
    canonicalCandidates: [],
    resolution: null,
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
