/**
 * Production orchestrator — Sovereign State Machine pipeline.
 *
 * streamHandler → process → sovereignRouter → llmOrchestrator → response delivery
 */
import { getConfig } from "../config.js";
import {
  clearCallerMemory,
  getCallerMemory,
  saveCallerMemory,
} from "../utils/callerMemory.js";
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
import { classifyFollowUpIntent, preAnalyzeOrderIntent, ensureUniqueSpokenResponse } from "../services/llmService.js";
import {
  clearActiveSession,
  createActiveSession,
  getOrCreateActiveSession,
  updateActiveSession,
} from "../sovereign/activeSession.js";
import {
  clearPreferredVoiceForCall,
  getPreferredVoiceForCall,
} from "../adapters/voiceAdapter.js";
import { resolveSovereignTurn } from "../sovereign/sovereignRouter.js";
import {
  buildResumeFromLastSpokenIndex,
  buildTrackingDictationChunks,
  calculateResumeOffset,
  resolveSpatialResumeFromQuery,
} from "./dictationTool.js";
import { extractSpatialAnchorDigits } from "../sovereign/spatialDictation.js";
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
import { syncDeterministicAssistantSpeech } from "../adapters/openaiAdapter.js";
import {
  buildRefundEmailFollowUpSpeech,
  isRefundNotificationEmailQuestion,
} from "./orderFollowUpSpeech.js";
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
  "Welcome to SureShot Books! I am your virtual assistant. How can I help you today?";

/** Create a new call session — voice layer must not mutate slots/intent/phase. */
export function createCallSession(callSid: string, from: string, to: string): CallSession {
  markCallSessionActive(callSid);
  const memory = getCallerMemory(from);
  const session: CallSession = {
    callSid,
    from,
    to,
    callerPhone: from,
    isVerifiedCaller: false,
    phase: "greeting",
    orderNumberAttempts: 0,
    createdAt: Date.now(),
    awaitingInput: null,
    greetedThisCall: false,
    welcomeBack: Boolean(memory),
    productSlots: undefined,
  };

  if (memory) {
    if (memory.shoppingCart?.length) {
      session.shoppingCart = memory.shoppingCart.map((line) => ({ ...line }));
    }
    if (memory.currentOrderData) {
      session.currentOrderData = { ...memory.currentOrderData };
    }
    if (memory.lastIntent) {
      session.lastOrchestratorIntent = memory.lastIntent;
    }
  }

  createActiveSession(callSid);

  return session;
}

/** Tear down all per-call resources when the relay socket closes. */
export function endCallSession(callSid: string, session?: CallSession): void {
  if (session) {
    saveCallerMemory({
      phone: session.callerPhone ?? session.from,
      lastIntent: session.lastOrchestratorIntent,
      shoppingCart: session.shoppingCart,
      currentOrderData: session.currentOrderData,
    });
  }
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
  clearActiveSession(callSid);
  clearPreferredVoiceForCall(callSid);
}

/**
 * Sole runtime entry point for user turns.
 * streamHandler → process → sovereignRouter → llmOrchestrator → response delivery
 */
export const USER_INTERRUPTED_DICTATION_SIGNAL = "User interrupted during dictation.";

/** Tracking / dictation phase gates — sole source of truth for handshake + dictation. */
export const GET_TRACKING_INTENT = "get_tracking";
export const PHASE_HANDSHAKE = "PHASE_HANDSHAKE";
export const PHASE_DICTATION = "PHASE_DICTATION";
export const USER_READY = "USER_READY";
export const LISTENING = "LISTENING";

export const NOTEPAD_HANDSHAKE_PROMPT =
  "Please have your pen and notepad ready. Let me know when you are ready.";

const TRACKING_QUERY_RE =
  /\b(tracking|track(?:ing)?\s*(?:id|number)|where\s+is\s+my\s+package|read\s+(?:me\s+)?(?:the\s+)?tracking)\b/i;

const NOTEPAD_READY_RE =
  /\b(ready|i'?m\s+ready|yes|ok|okay|go\s+ahead|all\s+set|you\s+can\s+go|note\s+it\s+down)\b/i;

const INTERRUPT_RESUME_RE =
  /\b(what\s+did\s+you\s+miss|missed\s+that|didn'?t\s+catch|repeat\s+from|continue\s+from|pick\s+up)\b/i;

interface TrackingPhaseResolution {
  handled: boolean;
  speech?: string;
  intentKey?: string;
  skipLlm?: boolean;
  skipTools?: boolean;
}

function trackingPayloadReady(active: ReturnType<typeof getOrCreateActiveSession>): boolean {
  return Boolean(active.lastSpokenPayload?.trackingForTts && active.spatialIndex.length > 0);
}

/** Sole tracking gate — notepad handshake, USER_READY, chunked dictation, spatial resume. */
export function resolveTrackingPhaseGate(
  callerText: string,
  session: CallSession,
): TrackingPhaseResolution {
  const active = getOrCreateActiveSession(session.callSid);
  const text = callerText.trim();
  if (!text) return { handled: false };

  if (INTERRUPT_RESUME_RE.test(text) && active.spatialIndex.length > 0 && active.lastSpokenIndex >= 0) {
    const resume = buildResumeFromLastSpokenIndex(active);
    if (resume) {
      return {
        handled: true,
        speech: resume,
        skipLlm: true,
        skipTools: true,
        intentKey: "spatial_resume_interrupt",
      };
    }
  }

  const spatialResume = resolveSpatialResumeFromQuery(text, active);
  if (spatialResume) {
    const anchor = extractSpatialAnchorDigits(text);
    if (anchor) {
      const offset = calculateResumeOffset(active.spatialIndex, anchor);
      updateActiveSession(session.callSid, {
        lastSpokenIndex: Math.max(offset - 1, -1),
        currentState: "tracking_dictation",
      });
    }
    return {
      handled: true,
      speech: spatialResume,
      skipLlm: true,
      skipTools: true,
      intentKey: "spatial_resume",
    };
  }

  if (active.currentState === "awaiting_notepad_ready" && trackingPayloadReady(active)) {
    if (NOTEPAD_READY_RE.test(text)) {
      updateActiveSession(session.callSid, {
        isNotepadReady: true,
        awaitingClarification: null,
        currentState: "tracking_dictation",
        lastSpokenIndex: -1,
      });
      return {
        handled: true,
        speech: active.lastSpokenPayload!.trackingForTts!,
        skipLlm: true,
        skipTools: true,
        intentKey: "dictate_tracking",
      };
    }
    return {
      handled: true,
      speech: NOTEPAD_HANDSHAKE_PROMPT,
      skipLlm: true,
      skipTools: true,
      intentKey: PHASE_HANDSHAKE,
    };
  }

  if (TRACKING_QUERY_RE.test(text) && active.lastSpokenPayload?.trackingForTts) {
    if (!active.isNotepadReady) {
      updateActiveSession(session.callSid, {
        currentState: "awaiting_notepad_ready",
        awaitingClarification: "notepad_ready",
        isNotepadReady: false,
        cachedIntent: GET_TRACKING_INTENT,
      });
      return {
        handled: true,
        speech: NOTEPAD_HANDSHAKE_PROMPT,
        skipLlm: true,
        skipTools: true,
        intentKey: PHASE_HANDSHAKE,
      };
    }
    updateActiveSession(session.callSid, {
      currentState: "tracking_dictation",
      lastSpokenIndex: -1,
    });
    return {
      handled: true,
      speech: active.lastSpokenPayload.trackingForTts,
      skipLlm: true,
      skipTools: true,
      intentKey: PHASE_DICTATION,
    };
  }

  return { handled: false };
}

/** @deprecated Use USER_INTERRUPTED_DICTATION_SIGNAL flow via process(). */
export const INTERRUPT_LISTENING_ACK =
  "Yes, I am listening. What did you miss?";

export function buildDictationInterruptSpeech(lastSpokenIndex: number): string {
  if (lastSpokenIndex < 0) {
    return "I am stopping. Understood. Tell me what you need now.";
  }
  return `I am stopping. Understood, you have noted the ID up to position ${lastSpokenIndex + 1}. Tell me what you need now.`;
}

/** @deprecated Interrupt turns route through process() with USER_INTERRUPTED_DICTATION_SIGNAL. */
export async function* processInterruptAcknowledgment(
  session: CallSession,
): AsyncGenerator<AgentStreamEvent> {
  const active = getOrCreateActiveSession(session.callSid);
  const speech = buildDictationInterruptSpeech(active.lastSpokenIndex);
  const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, speech, "");
  syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
    responseType: "general_help",
  });
  yield* yieldSpeech(uniqueSpeech);
  yield doneEvent(session.phase);
}

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
  updateActiveSession(callSid, { preferredVoice: getPreferredVoiceForCall(callSid) });
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

  if (text === USER_INTERRUPTED_DICTATION_SIGNAL) {
    const active = getOrCreateActiveSession(session.callSid);
    const speech = buildDictationInterruptSpeech(active.lastSpokenIndex);
    const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, speech, text);
    syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
      responseType: "general_help",
    });
    updateActiveSession(session.callSid, {
      currentState: "awaiting_clarification",
      agentRelayState: LISTENING,
    });
    yield* yieldSpeech(uniqueSpeech);
    yield doneEvent(session.phase);
    return;
  }

  const trackingGate = resolveTrackingPhaseGate(text, session);
  if (trackingGate.handled) {
    yield* yieldTrackingPhaseSpeech(session, text, trackingGate);
    return;
  }

  const sovereign = resolveSovereignTurn(text, session);
  if (sovereign.handled) {
    yield* yieldSovereignSpeech(session, text, sovereign);
    return;
  }

  if (session.phase === "order_disclosed" || session.phase === "follow_up") {
    yield* handleFollowUpPhase(session, text);
    return;
  }

  yield* runLlmOrchestratorTurn(session, text, emitResponseSent);
}

async function* yieldTrackingPhaseSpeech(
  session: CallSession,
  callerText: string,
  gate: TrackingPhaseResolution,
): AsyncGenerator<AgentStreamEvent> {
  if (!gate.speech) {
    yield doneEvent(session.phase);
    return;
  }

  const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, gate.speech, callerText);
  syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
    responseType: "general_help",
  });
  session.phase = session.phase === "greeting" ? "follow_up" : session.phase;

  const dictationIntents = new Set([
    "dictate_tracking",
    PHASE_DICTATION,
    "spatial_resume",
    "spatial_resume_interrupt",
  ]);

  if (dictationIntents.has(gate.intentKey ?? "")) {
    const active = getOrCreateActiveSession(session.callSid);
    const startIndex = active.lastSpokenIndex + 1;
    const chunks = buildTrackingDictationChunks(active.spatialIndex, startIndex);
    if (chunks.length > 0) {
      for (const chunk of chunks) {
        yield { type: "chunk", chunk };
      }
    } else {
      yield* yieldSpeech(uniqueSpeech, "dictation");
    }
  } else {
    yield* yieldSpeech(uniqueSpeech, "summary");
  }

  yield doneEvent(session.phase);
}

async function* yieldSovereignSpeech(
  session: CallSession,
  callerText: string,
  sovereign: import("../sovereign/sovereignRouter.js").SovereignTurnResolution,
): AsyncGenerator<AgentStreamEvent> {
  if (!sovereign.speech) {
    yield doneEvent(session.phase);
    return;
  }

  const uniqueSpeech = await ensureUniqueSpokenResponse(
    session.callSid,
    sovereign.speech,
    callerText,
  );
  syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
    responseType: "general_help",
  });
  session.phase = session.phase === "greeting" ? "follow_up" : session.phase;

  const dictationKinds = new Set([
    "dictate_tracking",
    PHASE_DICTATION,
    "spatial_resume",
    "spatial_resume_interrupt",
  ]);
  const chunkKind = dictationKinds.has(sovereign.intentKey ?? "") ? "dictation" : "summary";

  if (chunkKind === "dictation") {
    const active = getOrCreateActiveSession(session.callSid);
    const startIndex = active.lastSpokenIndex + 1;
    const chunks = buildTrackingDictationChunks(active.spatialIndex, startIndex);
    if (chunks.length > 0) {
      for (const chunk of chunks) {
        yield { type: "chunk", chunk };
      }
    } else {
      yield* yieldSpeech(uniqueSpeech, chunkKind);
    }
  } else {
    yield* yieldSpeech(uniqueSpeech, chunkKind);
  }
  yield doneEvent(session.phase);
}

async function* handleFollowUpPhase(
  session: CallSession,
  callerText: string,
): AsyncGenerator<AgentStreamEvent> {
  const trackingGate = resolveTrackingPhaseGate(callerText, session);
  if (trackingGate.handled) {
    yield* yieldTrackingPhaseSpeech(session, callerText, trackingGate);
    return;
  }

  const sovereign = resolveSovereignTurn(callerText, session);
  if (sovereign.handled) {
    yield* yieldSovereignSpeech(session, callerText, sovereign);
    return;
  }

  const intent = await classifyFollowUpIntent(callerText);

  if (intent === "goodbye") {
    session.phase = "ended";
    clearCallerMemory(session.callerPhone ?? session.from);
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

  if (
    session.currentOrderData &&
    Object.keys(session.currentOrderData).length > 0 &&
    isRefundNotificationEmailQuestion(callerText)
  ) {
    const speech = buildRefundEmailFollowUpSpeech(session.currentOrderData, callerText);
    session.phase = "follow_up";
    session.awaitingInput = null;
    const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, speech, callerText);
    syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
      responseType: "general_help",
    });
    yield* yieldSpeech(uniqueSpeech);
    yield doneEvent(session.phase);
    return;
  }

  session.phase = "follow_up";
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

// Inbound Twilio webhook → ConversationRelay → streamHandler → process()
export { handleInboundCall, handleRelayAction } from "../voice/twilioWebhook.js";

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
