/**
 * Production orchestrator — Sovereign State Machine pipeline.
 *
 * streamHandler → process → sovereignRouter → llmOrchestrator → response delivery
 */
import {
  wsUrl,
  conversationRelayVoice,
  isConversationRelayRuntime,
  getConfig,
} from "../config.js";
import { CALLER_WELCOME_BACK_GREETING } from "../utils/callerMemory.js";
import { ensureVoiceProviderReady, getLockedElevenLabsVoiceId } from "../adapters/voiceAdapter.js";
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
  ensureTrackingPayload,
  recordTrackingPayload,
  updateActiveSession,
  syncActiveSessionFromCallSession,
  buildSlowerTrackingReplaySpeech,
} from "../sovereign/activeSession.js";
import {
  clearPreferredVoiceForCall,
  getPreferredVoiceForCall,
} from "../adapters/voiceAdapter.js";
import { resolveSovereignTurn } from "../sovereign/sovereignRouter.js";
import {
  beginTrackingDictationAfterNotepadReady,
  beginTrackingNotepadHandshake,
  buildResumeFromLastSpokenIndex,
  buildTrackingDictationChunks,
  completeTrackingDictation,
  isTrackingOfferAcceptance,
  isUserNotepadReadyIntent,
  buildNotepadReadyNudge,
  appendTrackingDictationConfirm,
  promptUserForNotepad,
  TRACKING_DICTATION_COMPLETE_SPEECH,
  USER_NOTEPAD_READY,
} from "./dictationTool.js";
import { isSpatialBeforeQuery, isSpatialResumeQuery, resolveSpatialTurnSpeech, computeLastSpokenIndexAfterSpatialResume } from "../sovereign/spatialDictation.js";
import {
  planInstantFiller,
  planLookupError,
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
import { digitizeSpeechForIsbn, extractIsbnFromSpeech, isValidIsbnFormat } from "../utils/productSearchNormalize.js";
import { clearDialogueState } from "./dialogueManager.js";
import { runLlmOrchestratorTurn } from "./llmOrchestrator.js";
import { syncDeterministicAssistantSpeech } from "../adapters/openaiAdapter.js";
import {
  mergeProductSlots,
  parseProductSlotsFromSpeech,
  pickProductSlotQuestion,
  pickProductSlotQuestionForAwaiting,
} from "./productSlotPhase.js";
import { smoothForVoice, speechChunksFromText } from "../services/voiceSmoothingEngine.js";
import { isTrackingDictationText, sanitizeTextForTTS, sanitizeTrackingDictationSpeech } from "../utils/ttsFormatter.js";
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
import type { Request, Response } from "express";
import { validateTwilioSignature } from "../utils/twilioSignature.js";
import {
  buildClarifyingResponse,
  buildGreetingResponse,
  buildOrderNumberOfferResponse,
  isOrderNumberOfferUtterance,
  isSocialGreetingUtterance,
} from "../handlers/greetingHandler.js";
import { extractOrderNumberFromStt } from "../nlp/entityExtractor.js";
import { isCatalogShoppingUtterance } from "./catalogShoppingIntent.js";
import {
  hasConfirmedOrderContext,
  isOrderLookupRequestWithoutNumber,
  executeOrderLookupForSession,
} from "./orderContextPolicy.js";
import { isTrackingRequest, hasTrackingInSessionContext, isTrackingDictationCompleteIntent, shouldStartTrackingDictation, isContextualDictationRepeatRequest } from "./trackingIntent.js";
import {
  resolveCallerIntent,
  shouldRunTrackingPhaseGate,
  shouldExitTrackingHandshake,
  isIntentSwitchAwayFromTracking,
  type CallerIntent,
} from "./callerIntent.js";
import {
  buildOrderFieldQuerySpeech,
  buildRefundEmailFollowUpSpeech,
  isOrderFieldQuestion,
  isRefundNotificationEmailQuestion,
} from "./orderFollowUpSpeech.js";
import {
  appendProtocolClosing,
  buildOrderNumberPreflightSpeech,
  MAX_ORDER_NUMBER_ATTEMPTS,
  ORDER_NUMBER_ATTEMPTS_EXHAUSTED_SYSTEM_NOTE,
  syncTrackingOfferState,
} from "./orderLookupProtocol.js";
import { captureSessionIntent, callerAskedForTracking } from "./sessionMemory.js";
import { groundedOrderSpeech } from "./fulfillmentHandlers.js";
import type { ActiveOrderContextData } from "./sessionManager.js";
import {
  filterOrderContextForVerification,
  isRestrictedFieldQueryForUnverified,
  buildUnverifiedShippingAddressRefusal,
} from "./orderContextPrivacy.js";
import { resolveDisclosureFieldFromUtterance } from "./responsePolicy.js";
import {
  isProductSearchContextActive,
  syncActiveWorkflowContext,
} from "./workflowContext.js";
import { transitionFlowForIntent, clearConversationFlowMode, setConversationFlowMode } from "./conversationFlowState.js";
import {
  registerUnifiedSession,
  unregisterUnifiedSession,
  applyUnifiedWorkflowTransition,
  ensureUnifiedDefaults,
  getOrHydrateUnifiedSession,
  touchUnifiedSession,
  flushUnifiedSessionToL2,
} from "./unifiedCallSession.js";
import { clearLastSpokenSentence } from "../services/llmService.js";
import {
  applyBrainWorkflowControl,
  shouldPreferLlmPrimaryRouting,
  shouldSuppressSupportEscalation,
  tryDeterministicCartTurn,
} from "./agentBrain.js";
import {
  armPrivateInfoBlockedEscalation,
  buildUnverifiedRefusalWithSupportOffer,
  resolveSupportEscalationTurn,
} from "./supportEscalationFlow.js";
import {
  resolveEmailConfirmationTurn,
} from "./emailConfirmationManager.js";
import { resolvePaymentCheckoutTurn } from "./paymentCheckoutFlow.js";
import { buildOrderDetailSpeech } from "./orderDetailBuilder.js";
import { executeUnifiedTool } from "../adapters/unifiedToolRegistry.js";
import {
  buildMonthDrillDownSpeech,
  buildUnverifiedOrderHistorySpeech,
  buildVerifiedHistoryOverviewSpeech,
  isOrderHistoryContextActive,
  isOrderHistoryMonthFollowUp,
  parseMonthFromUtterance,
  selectMonthInHistoryContext,
  setOrderHistoryContext,
} from "./orderHistoryFlow.js";

export type BrainIntent = "order_status" | "product_search" | "general_help" | "unknown";

/** Fixed greeting spoken at call start (TwiML welcomeGreeting) — keep short; brain waits for caller. */
export const BRAIN_GREETING =
  "Hello, I am the SureShot Books assistant. How can I help you?";

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
    flowMode: "idle",
    sovereignState: "idle",
    activeWorkflowContext: "idle",
    sessionMemory: { initialIntent: null, pendingGoal: null },
  };

  if (memory) {
    if (memory.shoppingCart?.length) {
      session.shoppingCart = memory.shoppingCart.map((line) => ({ ...line }));
    }
    // Order context is never restored from memory — caller must provide order number again.
    if (memory.lastIntent) {
      session.lastOrchestratorIntent = memory.lastIntent;
    }
  }

  ensureUnifiedDefaults(session);
  registerUnifiedSession(session);
  createActiveSession(callSid);

  return session;
}

/**
 * Resolve a live call session: L1 registry → L2 Postgres hydrate → fresh create.
 * Twilio WS setup / reconnect must use this so restarts do not drop in-flight state.
 */
export async function createOrHydrateCallSession(
  callSid: string,
  from: string,
  to: string,
): Promise<CallSession> {
  const hydrated = await getOrHydrateUnifiedSession(callSid);
  if (hydrated) {
    markCallSessionActive(callSid);
    if (from && from !== "unknown") {
      hydrated.from = from;
      hydrated.callerPhone = hydrated.callerPhone ?? from;
    }
    if (to && to !== "unknown") {
      hydrated.to = to;
    }
    createActiveSession(callSid);
    if (hydrated.flowMode) {
      setConversationFlowMode(callSid, hydrated.flowMode);
    }
    syncActiveSessionFromCallSession(hydrated);
    touchUnifiedSession(hydrated);
    await flushUnifiedSessionToL2(hydrated);
    return hydrated;
  }
  return createCallSession(callSid, from, to);
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
  clearConversationFlowMode(callSid);
  clearLastSpokenSentence(callSid);
  unregisterUnifiedSession(callSid);
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

export const NOTEPAD_HANDSHAKE_PROMPT = promptUserForNotepad();

function shouldRejectOrderNumberCandidate(
  text: string,
  orderNumber: string,
  session?: CallSession,
): boolean {
  if (isCatalogShoppingUtterance(text)) return true;
  if (extractIsbnFromSpeech(text)) return true;
  if (session && isProductSearchContextActive(session)) return true;
  const digits = orderNumber.replace(/\D/g, "");
  if ((digits.length === 10 || digits.length === 13) && isValidIsbnFormat(digits)) {
    return true;
  }
  return (
    (digits.length === 10 || digits.length === 13) &&
    /\b(isbn|barcode|978|979)\b/i.test(text)
  );
}

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

function ensureTrackingPayloadFromSession(session: CallSession): void {
  const active = getOrCreateActiveSession(session.callSid);
  if (active.lastSpokenPayload?.trackingForTts) return;

  const trackingRaw = String(session.currentOrderData?.tracking_number ?? "").trim();
  if (trackingRaw) {
    ensureTrackingPayload(session.callSid, trackingRaw);
  }
}

function exitTrackingHandshakeForOrderQuery(callSid: string): void {
  const active = getOrCreateActiveSession(callSid);
  if (
    active.currentState === "awaiting_notepad_ready" ||
    active.currentState === "tracking_dictation"
  ) {
    if (active.cachedIntent === "tracking" || active.lastSpokenPayload?.kind === "tracking") {
      updateActiveSession(callSid, {
        currentState: "order_active",
        cachedIntent: "order",
        awaitingClarification: null,
        isNotepadReady: false,
      });
    }
  }
}

async function* yieldEmailConfirmationTurnIfActive(
  session: CallSession,
  callerText: string,
): AsyncGenerator<AgentStreamEvent, boolean> {
  const turn = await resolveEmailConfirmationTurn(session, callerText);
  if (!turn.handled) return false;

  exitTrackingHandshakeForOrderQuery(session.callSid);
  const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, turn.speech, callerText);
  syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
    responseType: "general_help",
  });
  session.phase = session.phase === "greeting" ? "follow_up" : session.phase;
  yield* yieldSpeech(uniqueSpeech);
  yield doneEvent(session.phase);
  return true;
}

async function* yieldPaymentCheckoutTurnIfActive(
  session: CallSession,
  callerText: string,
): AsyncGenerator<AgentStreamEvent, boolean> {
  const turn = resolvePaymentCheckoutTurn(session, callerText);
  if (!turn.handled) return false;

  const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, turn.speech, callerText);
  syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
    responseType: "general_help",
  });
  session.phase = session.phase === "greeting" ? "follow_up" : session.phase;
  yield* yieldSpeech(uniqueSpeech);
  yield doneEvent(session.phase);
  return true;
}

async function* yieldSupportEscalationTurnIfActive(
  session: CallSession,
  callerText: string,
): AsyncGenerator<AgentStreamEvent, boolean> {
  const turn = await resolveSupportEscalationTurn(session, callerText);
  if (!turn.handled) return false;

  exitTrackingHandshakeForOrderQuery(session.callSid);
  const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, turn.speech, callerText);
  syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
    responseType: "general_help",
  });
  session.phase = session.phase === "greeting" ? "follow_up" : session.phase;
  yield* yieldSpeech(uniqueSpeech);
  yield doneEvent(session.phase);
  return true;
}

function verifiedOrderContext(session: CallSession): ActiveOrderContextData {
  const raw = session.currentOrderData ?? {};
  return filterOrderContextForVerification(
    raw as ActiveOrderContextData,
    session.isVerifiedCaller === true,
  );
}

function buildOrderFieldSpeech(session: CallSession, callerText: string): string | null {
  const context = verifiedOrderContext(session);
  const registeredCustomerName = String(
    session.currentOrderData?.customer_name ?? session.currentOrder?.customerName ?? "",
  ).trim();
  const detailSpeech = buildOrderDetailSpeech(session, callerText, context);
  if (detailSpeech) return detailSpeech;
  return buildOrderFieldQuerySpeech(
    callerText,
    context,
    session.isVerifiedCaller === true,
    registeredCustomerName || undefined,
  );
}

async function resolveOrderHistorySpeech(
  session: CallSession,
  callerText: string,
  callerIntent: CallerIntent,
): Promise<string | null> {
  const inHistoryFlow =
    callerIntent === "order_history" ||
    (isOrderHistoryContextActive(session) && isOrderHistoryMonthFollowUp(callerText, session));

  if (!inHistoryFlow) return null;

  if (session.isVerifiedCaller !== true) {
    const count =
      session.totalOrderCount ??
      (session.currentOrderData?.total_order_count as number | undefined) ??
      0;
    armPrivateInfoBlockedEscalation(
      session,
      "order history",
      "Unverified caller requested detailed order history.",
    );
    return `${buildUnverifiedOrderHistorySpeech(count)} Would you like me to forward your request to our support team so they can verify you and follow up?`;
  }

  const monthToken = parseMonthFromUtterance(callerText);
  if (monthToken && isOrderHistoryContextActive(session) && session.orderHistoryContext) {
    selectMonthInHistoryContext(session, monthToken);
    return buildMonthDrillDownSpeech(session.orderHistoryContext, monthToken);
  }

  if (callerIntent === "order_history") {
    const customerId = session.shopifyCustomerId?.trim();
    if (!customerId) return null;
    const record = await executeUnifiedTool(
      "get_customer_history",
      {},
      session.callSid,
      session,
    );
    const data = record.data as
      | { status?: string; orders?: import("../adapters/shopifyStorefrontAdapter.js").CustomerHistoryOrderSummary[]; orderCount?: number }
      | undefined;
    if (!record.ok || data?.status !== "found") {
      return "I could not pull your order history right now. Please try again in a moment.";
    }
    const ctx = setOrderHistoryContext(
      session,
      data.orders ?? [],
      data.orderCount ?? data.orders?.length ?? 0,
    );
    return buildVerifiedHistoryOverviewSpeech(ctx);
  }

  return null;
}

async function* yieldOrderHistoryTurnIfReady(
  session: CallSession,
  callerText: string,
  callerIntent: CallerIntent,
): AsyncGenerator<AgentStreamEvent, boolean> {
  const speech = await resolveOrderHistorySpeech(session, callerText, callerIntent);
  if (!speech?.trim()) return false;

  exitTrackingHandshakeForOrderQuery(session.callSid);
  const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, speech, callerText);
  syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
    responseType: "general_help",
  });
  session.phase = session.phase === "greeting" ? "follow_up" : session.phase;
  yield* yieldSpeech(uniqueSpeech);
  yield doneEvent(session.phase);
  return true;
}

function tryResolveNotepadReadyTurn(
  text: string,
  session: CallSession,
): TrackingPhaseResolution | null {
  if (!isUserNotepadReadyIntent(text, session.callSid)) return null;

  ensureTrackingPayloadFromSession(session);
  const active = getOrCreateActiveSession(session.callSid);
  if (active.trackingDictationComplete) return null;
  if (!active.lastSpokenPayload?.trackingForTts && !hasTrackingInSessionContext(session.currentOrderData)) {
    return null;
  }

  const turn = beginTrackingDictationAfterNotepadReady(session.callSid);
  return {
    handled: true,
    speech: turn.speech,
    skipLlm: true,
    skipTools: true,
    intentKey: turn.ok ? USER_NOTEPAD_READY : PHASE_HANDSHAKE,
  };
}

/** "Repeat that" / "say it slower" — re-dictate lastSpokenDataPoint only (never full order JSON). */
function tryResolveContextualDictationRepeat(
  text: string,
  session: CallSession,
): TrackingPhaseResolution | null {
  if (!isContextualDictationRepeatRequest(text)) return null;

  const active = getOrCreateActiveSession(session.callSid);
  const trackingRaw =
    active.lastSpokenDataPoint?.kind === "tracking_number"
      ? active.lastSpokenDataPoint.raw
      : active.lastSpokenPayload?.trackingRaw ||
        String(session.currentOrderData?.tracking_number ?? "").trim();

  const hasTrackingContext =
    Boolean(trackingRaw) &&
    (active.lastSpokenPayload?.kind === "tracking" ||
      active.lastSpokenDataPoint?.kind === "tracking_number" ||
      active.currentState === "tracking_dictation" ||
      (active.currentState === "awaiting_notepad_ready" && active.cachedIntent === "tracking") ||
      active.cachedIntent === "tracking");

  if (!hasTrackingContext) return null;

  if (!active.isNotepadReady) {
    return {
      handled: true,
      speech: beginTrackingNotepadHandshake(session.callSid),
      skipLlm: true,
      skipTools: true,
      intentKey: PHASE_HANDSHAKE,
    };
  }

  ensureTrackingPayloadFromSession(session);
  const slower = buildSlowerTrackingReplaySpeech(session.callSid);
  if (!slower) return null;

  return {
    handled: true,
    speech: appendTrackingDictationConfirm(slower),
    skipLlm: true,
    skipTools: true,
    intentKey: "tracking_repeat_slower",
  };
}

function tryResolveTrackingOfferTurn(
  text: string,
  session: CallSession,
): TrackingPhaseResolution | null {
  if (!isTrackingOfferAcceptance(text, session)) return null;

  session.awaitingTrackingOffer = false;
  ensureTrackingPayloadFromSession(session);
  return {
    handled: true,
    speech: beginTrackingNotepadHandshake(session.callSid),
    skipLlm: true,
    skipTools: true,
    intentKey: PHASE_HANDSHAKE,
  };
}

function tryResolveSpatialTrackingTurn(
  text: string,
  session: CallSession,
): TrackingPhaseResolution | null {
  if (!isSpatialResumeQuery(text)) return null;

  ensureTrackingPayloadFromSession(session);
  const refreshed = getOrCreateActiveSession(session.callSid);
  if (!refreshed.spatialIndex.length) return null;

  const spatialTurn = resolveSpatialTurnSpeech(
    text,
    refreshed.spatialIndex,
    refreshed.lastSpokenPayload?.trackingRaw,
  );
  if (!spatialTurn.handled || !spatialTurn.speech) return null;

  if (spatialTurn.resumeOffset !== undefined && !isSpatialBeforeQuery(text)) {
    updateActiveSession(session.callSid, {
      lastSpokenIndex: computeLastSpokenIndexAfterSpatialResume(
        refreshed.spatialIndex,
        spatialTurn.resumeOffset,
      ),
      currentState: "tracking_dictation",
      cachedIntent: "tracking",
      isNotepadReady: true,
    });
  } else {
    updateActiveSession(session.callSid, {
      currentState: "tracking_dictation",
      cachedIntent: "tracking",
      isNotepadReady: true,
    });
  }

  return {
    handled: true,
    speech: sanitizeTrackingDictationSpeech(spatialTurn.speech),
    skipLlm: true,
    skipTools: true,
    intentKey: spatialTurn.anchor ? "spatial_resume" : "spatial_clarify",
  };
}

function tryResolveTrackingCompletionTurn(
  text: string,
  session: CallSession,
  active: ReturnType<typeof getOrCreateActiveSession>,
): TrackingPhaseResolution | null {
  const trackingDictationContext = {
    currentState: active.currentState,
    lastSpokenIndex: active.lastSpokenIndex,
    isNotepadReady: active.isNotepadReady,
  };

  const inTrackingFlow =
    Boolean(active.lastSpokenPayload?.trackingForTts) &&
    (active.currentState === "tracking_dictation" || active.cachedIntent === "tracking");

  if (!inTrackingFlow || !isTrackingDictationCompleteIntent(text, trackingDictationContext)) {
    return null;
  }

  completeTrackingDictation(session.callSid);
  session.phase = "follow_up";
  session.awaitingInput = null;

  const fieldAnswer = buildOrderFieldSpeech(session, text);
  if (fieldAnswer) {
    return {
      handled: true,
      speech: appendProtocolClosing(fieldAnswer),
      skipLlm: true,
      skipTools: true,
      intentKey: "order_field_query",
    };
  }

  if (isIntentSwitchAwayFromTracking(text, session)) {
    return { handled: false };
  }

  return {
    handled: true,
    speech: TRACKING_DICTATION_COMPLETE_SPEECH,
    skipLlm: true,
    skipTools: true,
    intentKey: "tracking_complete",
  };
}

/** Sole tracking gate — notepad handshake, USER_READY, chunked dictation, spatial resume. */
export function resolveTrackingPhaseGate(
  callerText: string,
  session: CallSession,
  callerIntent?: CallerIntent,
): TrackingPhaseResolution {
  const active = getOrCreateActiveSession(session.callSid);
  const text = callerText.trim();
  if (!text) return { handled: false };

  const intent = callerIntent ?? resolveCallerIntent(callerText, session);

  const completionTurn = tryResolveTrackingCompletionTurn(text, session, active);
  if (completionTurn) return completionTurn;

  const trackingOfferTurn = tryResolveTrackingOfferTurn(text, session);
  if (trackingOfferTurn) return trackingOfferTurn;

  const spatialTurn = tryResolveSpatialTrackingTurn(text, session);
  if (spatialTurn) return spatialTurn;

  const notepadReadyTurn = tryResolveNotepadReadyTurn(text, session);
  if (notepadReadyTurn) return notepadReadyTurn;

  const contextualRepeatTurn = tryResolveContextualDictationRepeat(text, session);
  if (contextualRepeatTurn) return contextualRepeatTurn;

  if (!shouldRunTrackingPhaseGate(intent)) {
    const preserveTrackingMidDictation =
      isSpatialResumeQuery(text) ||
      (active.currentState === "tracking_dictation" && active.spatialIndex.length > 0);
    if (
      !preserveTrackingMidDictation &&
      (active.currentState === "awaiting_notepad_ready" ||
        active.currentState === "tracking_dictation") &&
      active.cachedIntent === "tracking"
    ) {
      updateActiveSession(session.callSid, {
        currentState: "order_active",
        cachedIntent: "order",
        awaitingClarification: null,
        isNotepadReady: false,
      });
    }
    return { handled: false };
  }

  let refreshed = getOrCreateActiveSession(session.callSid);
  const wantsTrackingDictation = shouldStartTrackingDictation(
    text,
    refreshed.trackingDictationComplete === true,
    { session },
  );

  if (wantsTrackingDictation) {
    ensureTrackingPayloadFromSession(session);
    refreshed = getOrCreateActiveSession(session.callSid);
  }

  if (INTERRUPT_RESUME_RE.test(text) && refreshed.spatialIndex.length > 0 && refreshed.lastSpokenIndex >= 0) {
    const resume = buildResumeFromLastSpokenIndex(refreshed);
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

  if (refreshed.currentState === "awaiting_notepad_ready" && trackingPayloadReady(refreshed)) {
    if (shouldExitTrackingHandshake(intent)) {
      exitTrackingHandshakeForOrderQuery(session.callSid);
      return { handled: false };
    }

    if (isUserNotepadReadyIntent(text, session.callSid)) {
      const turn = beginTrackingDictationAfterNotepadReady(session.callSid);
      return {
        handled: true,
        speech: turn.speech,
        skipLlm: true,
        skipTools: true,
        intentKey: turn.ok ? USER_NOTEPAD_READY : PHASE_HANDSHAKE,
      };
    }

    if (/\b(how long|what number|which number|how many digits)\b/i.test(text)) {
      return {
        handled: true,
        speech:
          "I'll read your tracking ID one digit at a time once you confirm your pen and paper are ready. Just say ready when you're set.",
        skipLlm: true,
        skipTools: true,
        intentKey: "spatial_clarify",
      };
    }

    if (
      /\b(?:repeat|say (?:it )?again|one more time|can you repeat|read (?:it )?again|start over)\b/i.test(
        text,
      )
    ) {
      return {
        handled: true,
        speech: buildNotepadReadyNudge(),
        skipLlm: true,
        skipTools: true,
        intentKey: PHASE_HANDSHAKE,
      };
    }

    if (
      !wantsTrackingDictation &&
      intent !== "tracking_dictation" &&
      intent !== "tracking_flow_active"
    ) {
      exitTrackingHandshakeForOrderQuery(session.callSid);
      return { handled: false };
    }
  }

  const trackingContextReady = Boolean(
    refreshed.lastSpokenPayload?.trackingForTts || hasTrackingInSessionContext(session.currentOrderData),
  );

  if (wantsTrackingDictation && trackingContextReady) {
    session.awaitingTrackingOffer = false;
    if (!refreshed.isNotepadReady) {
      return {
        handled: true,
        speech: beginTrackingNotepadHandshake(session.callSid),
        skipLlm: true,
        skipTools: true,
        intentKey: PHASE_HANDSHAKE,
      };
    }

    const turn = beginTrackingDictationAfterNotepadReady(session.callSid);
    return {
      handled: true,
      speech: turn.speech,
      skipLlm: true,
      skipTools: true,
      intentKey: turn.ok ? USER_NOTEPAD_READY : PHASE_HANDSHAKE,
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

/**
 * Hard escapement after MAX_ORDER_NUMBER_ATTEMPTS failed captures.
 * Clears the order-number slot, updates UnifiedCallSession, and arms an LLM system note.
 */
function escapeOrderNumberCaptureLoop(session: CallSession): void {
  session.orderNumberAttempts = Math.max(
    session.orderNumberAttempts,
    MAX_ORDER_NUMBER_ATTEMPTS,
  );
  session.phase = "follow_up";
  session.awaitingInput = null;
  session.pendingLlmSystemNote = ORDER_NUMBER_ATTEMPTS_EXHAUSTED_SYSTEM_NOTE;
  applyUnifiedWorkflowTransition(session, "idle", {
    reason: "order_number_attempts_exhausted",
  });
  updateActiveSession(session.callSid, {
    currentState: "awaiting_clarification",
    cachedIntent: null,
  });
  touchUnifiedSession(session);
  logger.info("order_number_attempts_exhausted", {
    callSid: session.callSid.slice(0, 8),
    attempts: session.orderNumberAttempts,
  });
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
    touchUnifiedSession(session);
    try {
      await flushUnifiedSessionToL2(session);
    } catch (err) {
      logger.warn("orchestrator_turn_flush_failed", {
        callSid: session.callSid.slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
  syncActiveWorkflowContext(session);

  const callerIntentPreview = resolveCallerIntent(text, session);
  const brain = applyBrainWorkflowControl(session, text, callerIntentPreview);

  if (yield* yieldEmailConfirmationTurnIfActive(session, text)) {
    return;
  }

  if (brain.deterministicCartSpeech) {
    const uniqueSpeech = await ensureUniqueSpokenResponse(
      session.callSid,
      brain.deterministicCartSpeech,
      text,
    );
    syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
      responseType: "general_help",
    });
    yield* yieldSpeech(uniqueSpeech);
    yield doneEvent(session.phase);
    return;
  }

  if (
    !shouldSuppressSupportEscalation(session, text, callerIntentPreview) &&
    (yield* yieldSupportEscalationTurnIfActive(session, text))
  ) {
    return;
  }

  if (yield* yieldPaymentCheckoutTurnIfActive(session, text)) {
    return;
  }

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

  const callerIntent = callerIntentPreview;
  captureSessionIntent(session, text, callerIntent);
  if (callerIntent === "catalog") {
    session.lastOrchestratorIntent = "catalog";
    applyUnifiedWorkflowTransition(session, "product_search", {
      reason: "orchestrator_catalog_intent",
    });
  }
  syncActiveWorkflowContext(session);

  // LLM-primary: never trap catalog/product turns in the order-number preflight.
  const needsOrderNumberBeforeLookup =
    !hasConfirmedOrderContext(session) &&
    callerIntent !== "catalog" &&
    callerIntent !== "cart" &&
    !isProductSearchContextActive(session) &&
    !shouldPreferLlmPrimaryRouting(session, text, callerIntent) &&
    !isOrderNumberOfferUtterance(text) &&
    !extractOrderNumberFromStt(text, { awaitingSlot: true }) &&
    !extractOrderNumberFromSpeech(text) &&
    (callerIntent === "order_lookup" ||
      callerIntent === "tracking_dictation" ||
      callerAskedForTracking(session));

  if (needsOrderNumberBeforeLookup) {
    // Hard escapement: stop re-asking after MAX attempts; fall through to LLM.
    if (session.orderNumberAttempts >= MAX_ORDER_NUMBER_ATTEMPTS) {
      escapeOrderNumberCaptureLoop(session);
    } else {
      session.orderNumberAttempts += 1;
      session.phase = "awaiting_order_number";
      session.awaitingInput = "order_number";
      session.lastOrchestratorIntent = "order_lookup";
      updateActiveSession(session.callSid, { cachedIntent: "order" });
      touchUnifiedSession(session);
      const speech =
        session.orderNumberAttempts === 1
          ? buildOrderNumberPreflightSpeech(session)
          : buildClarifyingResponse(session.orderNumberAttempts - 1);
      const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, speech, text);
      syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
        responseType: "clarification_question",
      });
      yield* yieldSpeech(uniqueSpeech);
      yield doneEvent(session.phase);
      return;
    }
  }

  if (
    callerIntent === "catalog" ||
    callerIntent === "cart" ||
    callerIntent === "support_escalation" ||
    callerIntent === "order_history"
  ) {
    exitTrackingHandshakeForOrderQuery(session.callSid);
  }

  if (
    callerIntent === "order_field_query" &&
    hasConfirmedOrderContext(session)
  ) {
    if (
      session.isVerifiedCaller !== true &&
      isRestrictedFieldQueryForUnverified(text)
    ) {
      exitTrackingHandshakeForOrderQuery(session.callSid);
      const requested = resolveDisclosureFieldFromUtterance(text) ?? "protected order information";
      armPrivateInfoBlockedEscalation(
        session,
        requested,
        "Unverified caller requested vault-protected order information.",
      );
      const refusal = /\b(shipping\s+address|delivery\s+address)\b/i.test(text)
        ? buildUnverifiedShippingAddressRefusal()
        : buildUnverifiedRefusalWithSupportOffer(
            String(session.currentOrderData?.customer_name ?? ""),
          );
      const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, refusal, text);
      syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
        responseType: "general_help",
      });
      session.phase = session.phase === "greeting" ? "follow_up" : session.phase;
      yield* yieldSpeech(uniqueSpeech);
      yield doneEvent(session.phase);
      return;
    }

    const fieldSpeech = appendProtocolClosing(
      buildOrderFieldSpeech(session, text) ?? "",
    );
    if (fieldSpeech.trim() && !shouldPreferLlmPrimaryRouting(session, text, callerIntent)) {
      exitTrackingHandshakeForOrderQuery(session.callSid);
      const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, fieldSpeech, text);
      syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
        responseType: "general_help",
      });
      session.phase = session.phase === "greeting" ? "follow_up" : session.phase;
      yield* yieldSpeech(uniqueSpeech);
      yield doneEvent(session.phase);
      return;
    }
  }

  const trackingGate = resolveTrackingPhaseGate(text, session, callerIntent);
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

  if (session.phase === "greeting") {
    if (session.greetedThisCall) {
      session.phase = "follow_up";
    } else if (!session.greetedThisCall) {
      const orderLookupHandled = yield* handleGreetingPhaseOrderLookup(session, text);
      if (orderLookupHandled) {
        return;
      }
      session.greetedThisCall = true;
      session.phase = "follow_up";
    }
  }

  // If we're waiting for an order number, try deterministic lookup before the LLM.
  if (session.phase === "awaiting_order_number" || session.awaitingInput === "order_number") {
    const orderHandled = yield* handleAwaitingOrderNumberPhase(session, text);
    if (orderHandled) {
      return;
    }
  }

  // Warm deterministic greeting — never send pure hellos to the LLM.
  if (
    isSocialGreetingUtterance(text) &&
    session.phase !== "awaiting_order_number" &&
    session.awaitingInput !== "order_number"
  ) {
    const speech = buildGreetingResponse(text);
    const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, speech, text);
    syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
      responseType: "general_help",
    });
    if (!session.greetedThisCall) {
      session.greetedThisCall = true;
    }
    if (session.phase === "greeting") {
      session.phase = "follow_up";
    }
    yield* yieldSpeech(uniqueSpeech);
    yield doneEvent(session.phase);
    return;
  }

  // If we're waiting for an order number, respond warmly to social greetings mid-slot.
  if (session.phase === "awaiting_order_number") {
    const isSocialGreeting =
      /^(hi|hello|hey)\b/i.test(text) || /\bhow\s+are\s+you\b/i.test(text);

    if (isSocialGreeting) {
      session.awaitingInput = "order_number";
      const speech = buildGreetingResponse(text);
      const uniqueSpeech = await ensureUniqueSpokenResponse(
        session.callSid,
        speech,
        text,
      );
      syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
        responseType: "general_help",
      });
      yield* yieldSpeech(uniqueSpeech);
      yield doneEvent(session.phase);
      return;
    }
  }

  if (
    isOrderNumberOfferUtterance(text) &&
    !extractOrderNumberFromSpeech(text) &&
    !extractOrderNumberFromStt(text, { awaitingSlot: true })
  ) {
    if (session.orderNumberAttempts >= MAX_ORDER_NUMBER_ATTEMPTS) {
      escapeOrderNumberCaptureLoop(session);
    } else {
      session.orderNumberAttempts += 1;
      session.phase = "awaiting_order_number";
      session.awaitingInput = "order_number";
      session.lastOrchestratorIntent = "order_lookup";
      updateActiveSession(session.callSid, { cachedIntent: "order" });
      touchUnifiedSession(session);
      const speech = buildOrderNumberOfferResponse();
      const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, speech, text);
      syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
        responseType: "clarification_question",
      });
      emitResponseSent(session.callSid, "clarification_question", uniqueSpeech);
      yield* yieldSpeech(uniqueSpeech);
      yield doneEvent(session.phase);
      return;
    }
  }

  if (yield* yieldOrderHistoryTurnIfReady(session, text, callerIntent)) {
    return;
  }

  yield* runLlmOrchestratorTurn(session, text, emitResponseSent);
}

async function* handleAwaitingOrderNumberPhase(
  session: CallSession,
  callerText: string,
): AsyncGenerator<AgentStreamEvent, boolean> {
  const text = callerText.trim();
  if (!text) return false;

  if (isSocialGreetingUtterance(text)) {
    return false;
  }

  const pivotIntent = resolveCallerIntent(text, session);
  if (
    pivotIntent === "catalog" ||
    pivotIntent === "cart" ||
    pivotIntent === "support_escalation"
  ) {
    // Caller left the order-number slot — buy / cart / support takes over.
    session.phase = "follow_up";
    session.awaitingInput = null;
    return false;
  }

  const orderNumber =
    extractOrderNumberFromSpeech(text) ??
    extractOrderNumberFromStt(text, { awaitingSlot: true });

  if (orderNumber) {
    if (shouldRejectOrderNumberCandidate(text, orderNumber, session)) {
      session.phase = "follow_up";
      session.awaitingInput = null;
      transitionFlowForIntent(session.callSid, "catalog");
      session.lastOrchestratorIntent = "catalog";
      return false;
    }
    yield chunkEvent(planInstantFiller("get_shopify_order_status"));
    const lookup = await executeOrderLookupForSession(session, orderNumber);
    if (lookup.status === "found" && lookup.order) {
      session.phase = "order_disclosed";
      session.awaitingInput = null;
      session.orderNumberAttempts = 0;
      session.pendingLlmSystemNote = undefined;
      session.lastOrchestratorIntent = "order_lookup";
      updateActiveSession(session.callSid, { cachedIntent: "order" });
      touchUnifiedSession(session);
      yield* streamOrderSummary(lookup.order, session);
      emitResponseSent(session.callSid, "order_found", "Order found.");
    } else {
      session.orderNumberAttempts += 1;
      if (session.orderNumberAttempts >= MAX_ORDER_NUMBER_ATTEMPTS) {
        escapeOrderNumberCaptureLoop(session);
        // Fall through to general LLM with system note — do not re-ask.
        return false;
      }
      session.phase = "awaiting_order_number";
      session.awaitingInput = "order_number";
      touchUnifiedSession(session);
      const errorPlan = planLookupError(lookup);
      const speech = errorPlan.chunks.map((c) => c.text).join(" ") || buildClarifyingResponse(1);
      const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, speech, text);
      syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
        responseType: lookup.status === "invalid_format" ? "clarification_question" : "order_not_found",
      });
      emitResponseSent(
        session.callSid,
        lookup.status === "invalid_format" ? "clarification_question" : "order_not_found",
        uniqueSpeech,
      );
      yield* yieldSpeech(uniqueSpeech);
    }
    yield doneEvent(session.phase);
    return true;
  }

  if (isOrderNumberOfferUtterance(text)) {
    if (session.orderNumberAttempts >= MAX_ORDER_NUMBER_ATTEMPTS) {
      escapeOrderNumberCaptureLoop(session);
      return false;
    }
    session.orderNumberAttempts += 1;
    session.phase = "awaiting_order_number";
    session.awaitingInput = "order_number";
    touchUnifiedSession(session);
    const speech = buildOrderNumberOfferResponse();
    const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, speech, text);
    syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
      responseType: "clarification_question",
    });
    emitResponseSent(session.callSid, "clarification_question", uniqueSpeech);
    yield* yieldSpeech(uniqueSpeech);
    yield doneEvent(session.phase);
    return true;
  }

  return false;
}

async function* handleGreetingPhaseOrderLookup(
  session: CallSession,
  callerText: string,
): AsyncGenerator<AgentStreamEvent, boolean> {
  const text = callerText.trim();
  const orderNumber = extractOrderNumberFromSpeech(text);

  if (orderNumber) {
    if (shouldRejectOrderNumberCandidate(text, orderNumber, session)) {
      session.phase = "follow_up";
      session.awaitingInput = null;
      transitionFlowForIntent(session.callSid, "catalog");
      session.lastOrchestratorIntent = "catalog";
      return false;
    }
    yield chunkEvent(planInstantFiller("get_shopify_order_status"));
    const lookup = await executeOrderLookupForSession(session, orderNumber);
    if (lookup.status === "found" && lookup.order) {
      session.phase = "order_disclosed";
      session.awaitingInput = null;
      session.orderNumberAttempts = 0;
      session.pendingLlmSystemNote = undefined;
      session.lastOrchestratorIntent = "order_lookup";
      updateActiveSession(session.callSid, { cachedIntent: "order" });
      touchUnifiedSession(session);
      yield* streamOrderSummary(lookup.order, session);
      emitResponseSent(session.callSid, "order_found", "Order found.");
    } else {
      session.orderNumberAttempts += 1;
      if (session.orderNumberAttempts >= MAX_ORDER_NUMBER_ATTEMPTS) {
        escapeOrderNumberCaptureLoop(session);
        return false;
      }
      session.phase = "awaiting_order_number";
      session.awaitingInput = "order_number";
      touchUnifiedSession(session);
      const errorPlan = planLookupError(lookup);
      const speech = errorPlan.chunks.map((c) => c.text).join(" ") || buildClarifyingResponse();
      const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, speech, text);
      syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
        responseType: lookup.status === "invalid_format" ? "clarification_question" : "order_not_found",
      });
      emitResponseSent(
        session.callSid,
        lookup.status === "invalid_format" ? "clarification_question" : "order_not_found",
        uniqueSpeech,
      );
      yield* yieldSpeech(uniqueSpeech);
    }
    yield doneEvent(session.phase);
    return true;
  }

  const intent = classifyOrchestratorIntent(text);
  const orderLookupIntent =
    intent === "order_status" ||
    (intent === "unknown" && /\b(order|#\d|tracking|shipment|refund)\b/i.test(text));

  if (!orderLookupIntent) {
    return false;
  }

  if (session.greetedThisCall) {
    return false;
  }

  const speech =
    intent === "order_status" ? buildClarifyingResponse() : buildGreetingResponse(text);

  session.orderNumberAttempts += 1;
  session.phase = "awaiting_order_number";
  session.awaitingInput = "order_number";
  session.lastOrchestratorIntent = "order_lookup";
  session.greetedThisCall = true;
  updateActiveSession(session.callSid, { cachedIntent: "order" });
  touchUnifiedSession(session);

  const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, speech, text);
  syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
    responseType: "clarification_question",
  });
  emitResponseSent(session.callSid, "clarification_question", uniqueSpeech);
  yield* yieldSpeech(uniqueSpeech);
  yield doneEvent(session.phase);
  return true;
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

  const dictationIntents = new Set([USER_NOTEPAD_READY, PHASE_DICTATION, "dictate_tracking"]);
  const spatialIntents = new Set([
    "spatial_resume",
    "spatial_resume_interrupt",
    "spatial_clarify",
  ]);

  if (spatialIntents.has(gate.intentKey ?? "")) {
    yield* yieldSpeech(uniqueSpeech, "dictation");
  } else if (dictationIntents.has(gate.intentKey ?? "")) {
    const active = getOrCreateActiveSession(session.callSid);
    const startIndex = active.lastSpokenIndex + 1;
    const chunks = buildTrackingDictationChunks(active.spatialIndex, startIndex);
    if (chunks.length > 0) {
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const isLast = i === chunks.length - 1;
        yield {
          type: "chunk",
          chunk: isLast
            ? {
                ...chunk,
                text: appendTrackingDictationConfirm(chunk.text),
                preserveFull: true,
              }
            : chunk,
        };
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
    USER_NOTEPAD_READY,
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
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const isLast = i === chunks.length - 1;
        yield {
          type: "chunk",
          chunk: isLast
            ? {
                ...chunk,
                text: appendTrackingDictationConfirm(chunk.text),
                preserveFull: true,
              }
            : chunk,
        };
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
  if (yield* yieldEmailConfirmationTurnIfActive(session, callerText)) {
    return;
  }

  const followIntent = resolveCallerIntent(callerText, session);
  const followBrain = applyBrainWorkflowControl(session, callerText, followIntent);
  if (followBrain.deterministicCartSpeech) {
    const uniqueSpeech = await ensureUniqueSpokenResponse(
      session.callSid,
      followBrain.deterministicCartSpeech,
      callerText,
    );
    syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
      responseType: "general_help",
    });
    yield* yieldSpeech(uniqueSpeech);
    yield doneEvent(session.phase);
    return;
  }

  if (
    !shouldSuppressSupportEscalation(session, callerText, followIntent) &&
    (yield* yieldSupportEscalationTurnIfActive(session, callerText))
  ) {
    return;
  }

  if (yield* yieldPaymentCheckoutTurnIfActive(session, callerText)) {
    return;
  }

  const callerIntent = resolveCallerIntent(callerText, session);

  if (
    callerIntent === "order_history" ||
    callerIntent === "cart" ||
    callerIntent === "catalog" ||
    callerIntent === "support_escalation"
  ) {
    exitTrackingHandshakeForOrderQuery(session.callSid);
    if (callerIntent === "catalog" || callerIntent === "cart") {
      applyUnifiedWorkflowTransition(session, "product_search", {
        reason: "followup_catalog_pivot",
      });
      session.awaitingInput = null;
      if (session.phase === "awaiting_order_number") {
        session.phase = "follow_up";
      }
      updateActiveSession(session.callSid, {
        currentState: callerIntent === "cart" ? "cart_active" : "catalog_active",
        cachedIntent: callerIntent,
      });
    }
  }

  if (
    callerIntent === "order_field_query" &&
    hasConfirmedOrderContext(session)
  ) {
    if (
      session.isVerifiedCaller !== true &&
      isRestrictedFieldQueryForUnverified(callerText)
    ) {
      exitTrackingHandshakeForOrderQuery(session.callSid);
      const requested = resolveDisclosureFieldFromUtterance(callerText) ?? "protected order information";
      armPrivateInfoBlockedEscalation(
        session,
        requested,
        "Unverified caller requested vault-protected order information.",
      );
      const refusal = /\b(shipping\s+address|delivery\s+address)\b/i.test(callerText)
        ? buildUnverifiedShippingAddressRefusal()
        : buildUnverifiedRefusalWithSupportOffer(
            String(session.currentOrderData?.customer_name ?? ""),
          );
      const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, refusal, callerText);
      syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
        responseType: "general_help",
      });
      session.phase = "follow_up";
      yield* yieldSpeech(uniqueSpeech);
      yield doneEvent(session.phase);
      return;
    }

    const fieldSpeech = appendProtocolClosing(
      buildOrderFieldSpeech(session, callerText) ?? "",
    );
    // Supreme semantic router: skip deterministic field speech when LLM-primary.
    if (fieldSpeech.trim() && !shouldPreferLlmPrimaryRouting(session, callerText, callerIntent)) {
      exitTrackingHandshakeForOrderQuery(session.callSid);
      const uniqueSpeech = await ensureUniqueSpokenResponse(session.callSid, fieldSpeech, callerText);
      syncDeterministicAssistantSpeech(session.callSid, uniqueSpeech, {
        responseType: "general_help",
      });
      session.phase = "follow_up";
      yield* yieldSpeech(uniqueSpeech);
      yield doneEvent(session.phase);
      return;
    }
  }

  const trackingGate = resolveTrackingPhaseGate(callerText, session, callerIntent);
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
    const active = getOrCreateActiveSession(session.callSid);
    if (
      active.currentState === "tracking_dictation" ||
      (active.currentState === "awaiting_notepad_ready" && active.cachedIntent === "tracking")
    ) {
      const trackingRetry = resolveTrackingPhaseGate(callerText, session, callerIntent);
      if (trackingRetry.handled) {
        yield* yieldTrackingPhaseSpeech(session, callerText, trackingRetry);
        return;
      }
    } else {
      yield chunkEvent(planRepeatIntro());
      yield* streamOrderSummary(session.currentOrder, session);
      session.phase = "follow_up";
      yield doneEvent(session.phase);
      return;
    }
  }

  if (
    session.currentOrderData &&
    hasConfirmedOrderContext(session) &&
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
  if (yield* yieldOrderHistoryTurnIfReady(session, callerText, callerIntent)) {
    return;
  }
  yield* runLlmOrchestratorTurn(session, callerText, emitResponseSent);
}

async function* streamOrderSummary(
  order: StructuredOrder,
  session: CallSession,
): AsyncGenerator<AgentStreamEvent> {
  const result = session.lastOrderStatusResult;
  if (result?.status === "found") {
    const speech = groundedOrderSpeech(result, session);
    syncTrackingOfferState(speech, session);
    yield* yieldSpeech(speech);
    return;
  }
  void order;
  yield* yieldSpeech("I could not load your order summary. Please try again.");
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

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

function maskInboundPhone(number: string): string {
  const digits = number.replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "***";
}

function escapeTwiml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderMediaStreamTwiml(params: {
  wsUrl: string;
  from: string;
  to: string;
  welcomeGreeting: string;
  routerSpeech?: string;
}): string {
  const parameters = [
    `<Parameter name="from" value="${escapeTwiml(params.from)}"/>`,
    `<Parameter name="to" value="${escapeTwiml(params.to)}"/>`,
    `<Parameter name="welcomeGreeting" value="${escapeTwiml(params.welcomeGreeting)}"/>`,
  ];
  if (params.routerSpeech) {
    parameters.push(
      `<Parameter name="routerSpeech" value="${escapeTwiml(params.routerSpeech)}"/>`,
    );
  }

  return `${XML_HEADER}<Response><Connect><Stream url="${escapeTwiml(params.wsUrl)}">${parameters.join("")}</Stream></Connect></Response>`;
}

function renderConversationRelayTwiml(params: {
  wsUrl: string;
  from: string;
  to: string;
  welcomeGreeting: string;
  routerSpeech?: string;
}): string {
  const cfg = getConfig();
  const voice = conversationRelayVoice();
  const parameters = [
    `<Parameter name="from" value="${escapeTwiml(params.from)}"/>`,
    `<Parameter name="to" value="${escapeTwiml(params.to)}"/>`,
    `<Parameter name="welcomeGreeting" value="${escapeTwiml(params.welcomeGreeting)}"/>`,
  ];
  if (params.routerSpeech) {
    parameters.push(
      `<Parameter name="routerSpeech" value="${escapeTwiml(params.routerSpeech)}"/>`,
    );
  }

  return `${XML_HEADER}<Response><Connect><ConversationRelay url="${escapeTwiml(params.wsUrl)}" voice="${escapeTwiml(voice)}" ttsProvider="ElevenLabs" language="${escapeTwiml(cfg.VOICE_LANGUAGE)}" elevenlabsTextNormalization="${escapeTwiml(cfg.ELEVENLABS_TEXT_NORMALIZATION)}" welcomeGreeting="${escapeTwiml(params.welcomeGreeting)}" interruptible="speech">${parameters.join("")}</ConversationRelay></Connect></Response>`;
}

/** Inbound Twilio webhook → ConversationRelay or Media Streams → process() */
export async function handleInboundCall(req: Request, res: Response): Promise<void> {
  const conversationRelay = isConversationRelayRuntime();

  if (conversationRelay) {
    if (!getLockedElevenLabsVoiceId()) {
      logger.error("inbound_rejected_voice_id_missing");
      res.status(500).json({ ok: false, error: "voice_id_not_configured" });
      return;
    }
  } else {
    const voiceReady = ensureVoiceProviderReady();
    if (!voiceReady.ok) {
      logger.error("inbound_rejected_voice_provider_uninitialized", {
        error: voiceReady.error,
      });
      res.status(500).json({
        ok: false,
        error: "voice_provider_unavailable",
      });
      return;
    }
  }

  const cfg = getConfig();
  await validateTwilioSignature(req, cfg.TWILIO_AUTH_TOKEN, cfg.VALIDATE_TWILIO_SIGNATURES, {
    routerForwardSecret: cfg.VOICE_ROUTER_FORWARD_SECRET,
    publicBaseUrl: cfg.PUBLIC_BASE_URL,
  });

  const callSid = String(req.body.CallSid ?? "");
  const from = String(req.body.From ?? "unknown");
  const to = String(req.body.To ?? "unknown");

  logger.info("inbound_call", {
    callSid: callSid.slice(0, 8),
    from: maskInboundPhone(from),
    to: maskInboundPhone(to),
    wsUrl: wsUrl(),
    voiceId: getLockedElevenLabsVoiceId() || undefined,
    runtime: conversationRelay ? "twilio_conversation_relay" : "twilio_media_streams",
  });

  const routerSpeech = String(req.body.RouterSpeech ?? "").trim();
  const returningCaller = Boolean(getCallerMemory(from));

  const welcomeGreeting = routerSpeech
    ? "One moment while I look that up for you."
    : returningCaller
      ? CALLER_WELCOME_BACK_GREETING
      : BRAIN_GREETING;

  const twiml = conversationRelay
    ? renderConversationRelayTwiml({
        wsUrl: wsUrl(),
        from,
        to,
        welcomeGreeting,
        routerSpeech: routerSpeech || undefined,
      })
    : renderMediaStreamTwiml({
        wsUrl: wsUrl(),
        from,
        to,
        welcomeGreeting,
        routerSpeech: routerSpeech || undefined,
      });

  res.type("application/xml").send(twiml);
}

// Re-export slot helpers for tests
export { analyzeBrainTurn } from "./brainAnalyzer.js";
export { mergeProductSlots,
  parseProductSlotsFromSpeech,
  pickProductSlotQuestion,
} from "./productSlotPhase.js";
