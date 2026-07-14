/**
 * OpenAI tool-calling adapter — ElevenLabs-style fluid dialogue with Shopify tools.
 */
import OpenAI from "openai";
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { SHOSHAN_SYSTEM_PROMPT } from "../prompts/systemPrompt.js";
import {
  normalizeLlmToolName,
  toolResultForLlm,
  type LlmToolExecutionRecord,
  type LlmToolName,
} from "./llmToolExecutor.js";
import { UNIFIED_OPENAI_TOOL_SCHEMAS } from "./unifiedToolRegistry.js";
import type { OrderLookupStatus } from "../types/order.js";
import { ServiceRegistry } from "../sovereign/serviceRegistry.js";
import {
  getCurrentSessionOrderNumber,
  isOrderLookupComplete,
  isOrderLookupInsistenceUtterance,
  shouldBlockOrderLookupReinvoke,
  speechForOrderLookupResult,
} from "../agents/orderLookupWorkflow.js";
import { getLlmOrchestratorTemperature, isLlmStreamingEnabled } from "../agents/llmConfig.js";
import { extractOrderNumberFromStt } from "../nlp/entityExtractor.js";
import { ORDER_NOT_FOUND_STRICT_SPOKEN, SHOPIFY_TIMEOUT_SPOKEN } from "../constants/systemMessages.js";
import { dispatchAgentEvent, getAgentState } from "../platform/eventDispatcher.js";
import { extractOrderNumberFromSpeech, orderNumbersMatch } from "../utils/formatter.js";
import { buildPolitePivotSpeech, isOutOfDomainQuestion } from "../utils/domainGuard.js";
import { buildActiveOrderContextSystemMessage, getActiveOrderTrackingNumber, getActiveOrderContext, redactTrackingFromOrderContext } from "../agents/sessionManager.js";
import {
  isBareQuantityReply,
  lastAssistantAskedForQuantity,
  mapNaturalLanguageToInteger,
} from "../agents/catalogShoppingIntent.js";
import { getSessionMemory, ensureSessionMemory } from "../agents/sessionMemory.js";
import {
  decideTurnEnd,
  mergeListeningWaitBuffer,
} from "./turnEndHeuristics.js";
import { filterOrderContextForVerification } from "../agents/orderContextPrivacy.js";
import type { ActiveOrderContextData } from "../agents/sessionManager.js";
import { buildCartContextSystemMessage } from "../agents/cartManager.js";
import { buildCatalogTargetSystemMessage } from "../agents/catalogTarget.js";
import { hasConfirmedOrderContext } from "../agents/orderContextPolicy.js";
import { buildVaultSecuritySystemMessage } from "../agents/callerVerification.js";
import { buildOrderContextStructuredSystemMessages } from "../agents/orderContextPromptFactory.js";
import type { CallSession } from "../types/order.js";
import {
  appendProtocolClosing,
  buildStickyOrderStillOpenSpeech,
} from "../agents/orderLookupProtocol.js";
import {
  buildOrderFieldQuerySpeech,
  buildRefundEmailFollowUpSpeech,
  isOrderFieldQuestion,
  isRefundNotificationEmailQuestion,
} from "../agents/orderFollowUpSpeech.js";
import type { FinalResponseType } from "../runtime/turnObservability.js";
import {
  buildCallerWelcomeBackSystemMessage,
  SURESHOT_GOODBYE_SPEECH,
} from "../utils/callerMemory.js";
import {
  isClosingConversationUtterance,
  shouldBlockPrematureEndCall,
  shouldOfferEndCallTool,
  ensureUniqueSpokenResponse,
} from "../services/llmService.js";
import { pullCompletedSpeechPhrases } from "../services/voiceSmoothingEngine.js";
import { getTurnAbortSignal, getTurnGeneration, isStaleTurnGeneration, isTurnAborted } from "../runtime/turnAbortRegistry.js";
import {
  buildClarifyingResponse,
  buildGreetingResponse,
  buildOrderNumberOfferResponse,
  isOrderNumberOfferUtterance,
  isSocialGreetingUtterance,
} from "../handlers/greetingHandler.js";
import { stripRoboticAssistantSpeech, softFallback } from "../agents/conversationBrainAgent.js";
import { isCatalogShoppingUtterance } from "../agents/catalogShoppingIntent.js";
import {
  buildLockedFlowSystemMessage,
  isLockedFlowState,
  isPaymentLinkActionUtterance,
} from "../agents/lockedFlowState.js";
import {
  buildActiveSessionSystemMessage,
  getOrCreateActiveSession,
  ensureTrackingPayload,
  shouldSkipToolReinvoke,
  buildSlowerTrackingReplaySpeech,
  setAgentRelayState,
} from "../sovereign/activeSession.js";
import { buildEmailConfirmationSystemMessage } from "../agents/emailConfirmationManager.js";
import { NOTEPAD_HANDSHAKE_PROMPT } from "../sovereign/sovereignRouter.js";
import {
  isTrackingRequest,
  hasTrackingInSessionContext,
  isTrackingDictationCompleteIntent,
  shouldStartTrackingDictation,
  isContextualDictationRepeatRequest,
  type TrackingDictationGateContext,
} from "../agents/trackingIntent.js";
import { resolveDictateTracking } from "../sovereign/dictateTrackingGate.js";
import { isSpatialResumeQuery, resolveSpatialTurnSpeech } from "../sovereign/spatialDictation.js";
import {
  promptUserForNotepad,
  completeTrackingDictation,
  TRACKING_DICTATION_COMPLETE_SPEECH,
  appendTrackingDictationConfirm,
} from "../agents/dictationTool.js";
import { isTrackingDictationText } from "../utils/ttsFormatter.js";
import {
  isIntentSwitchAwayFromTracking,
  releaseTrackingFlowForIntentSwitch,
  resolveCallerIntent,
} from "../agents/callerIntent.js";
import { extractIsbnFromSpeech, isValidIsbnFormat } from "../utils/productSearchNormalize.js";

/** @deprecated Import UNIFIED_OPENAI_TOOL_SCHEMAS from unifiedToolRegistry — alias retained for callers. */
export const SHOPIFY_LLM_TOOLS: OpenAI.Chat.ChatCompletionTool[] = UNIFIED_OPENAI_TOOL_SCHEMAS;

export interface LlmChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmAgentTurnInput {
  callSid: string;
  userMessage: string;
  messages: LlmChatMessage[];
  session?: CallSession;
  /** Injected on follow-up turns — full order JSON for field answers after the initial summary. */
  activeOrderContext?: ActiveOrderContextData;
}

export interface LlmAgentTurnResult {
  speech: string;
  toolExecutions: LlmToolExecutionRecord[];
  responseType: FinalResponseType;
  recordOrderNumber?: string;
  recordProduct?: { id: string; title: string };
  endCall?: boolean;
}

export type LlmAgentTurnEvent =
  | { type: "tool_pending"; tools: LlmToolName[] }
  | { type: "speech_delta"; text: string }
  | { type: "result"; result: LlmAgentTurnResult };

type TurnOverride = (input: LlmAgentTurnInput) => Promise<LlmAgentTurnResult>;

let turnOverride: TurnOverride | null = null;

export function setLlmAgentTurnOverride(handler: TurnOverride | null): void {
  turnOverride = handler;
}

export function clearLlmAgentTurnOverride(): void {
  turnOverride = null;
}

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: getConfig().OPENAI_API_KEY,
      timeout: getConfig().OPENAI_TIMEOUT_MS,
    });
  }
  return client;
}

const MAX_TOOL_ROUNDS = 4;

type StreamedAssistantRound = {
  content: string;
  toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[];
  finishReason: string | null | undefined;
  streamedSpeech: boolean;
};

/**
 * Stream one OpenAI chat round. Emits speech_delta on sentence/phrase boundaries
 * for text-only replies; accumulates tool_calls without speaking.
 * Honors STREAMING_ENABLED (production default true) and LLM_TEMPERATURE (default 0.2).
 */
async function* streamAssistantRound(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  input: LlmAgentTurnInput,
): AsyncGenerator<
  { type: "speech_delta"; text: string } | { type: "round"; round: StreamedAssistantRound }
> {
  const signal = getTurnAbortSignal(input.callSid);
  const temperature = getLlmOrchestratorTemperature();
  const streaming = isLlmStreamingEnabled();

  if (!streaming) {
    const completion = await getClient().chat.completions.create(
      {
        model: getConfig().CONVERSATION_BRAIN_MODEL,
        temperature,
        max_tokens: 450,
        tools: resolveToolsForTurn(input),
        tool_choice: "auto",
        messages,
        stream: false,
      },
      signal ? { signal } : undefined,
    );
    const choice = completion.choices[0];
    const content = choice?.message?.content?.trim() ?? "";
    const toolCalls = choice?.message?.tool_calls ?? [];
    if (content && !toolCalls.length) {
      yield { type: "speech_delta", text: content };
    }
    yield {
      type: "round",
      round: {
        content,
        toolCalls,
        finishReason: choice?.finish_reason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
        streamedSpeech: Boolean(content && !toolCalls.length),
      },
    };
    return;
  }

  const stream = await getClient().chat.completions.create(
    {
      model: getConfig().CONVERSATION_BRAIN_MODEL,
      temperature,
      max_tokens: 450,
      tools: resolveToolsForTurn(input),
      tool_choice: "auto",
      messages,
      stream: true,
    },
    signal ? { signal } : undefined,
  );

  let content = "";
  let phraseBuffer = "";
  let streamedSpeech = false;
  let sawToolCalls = false;
  const toolCallAcc = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason: string | null | undefined;

  for await (const part of stream) {
    if (isTurnAborted(input.callSid)) {
      break;
    }
    const choice = part.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
    const delta = choice.delta;
    if (!delta) continue;

    if (delta.tool_calls?.length) {
      sawToolCalls = true;
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const prev = toolCallAcc.get(idx) ?? { id: "", name: "", arguments: "" };
        if (tc.id) prev.id = tc.id;
        if (tc.function?.name) prev.name = prev.name ? prev.name + tc.function.name : tc.function.name;
        if (tc.function?.arguments) prev.arguments += tc.function.arguments;
        toolCallAcc.set(idx, prev);
      }
      continue;
    }

    if (typeof delta.content === "string" && delta.content.length > 0 && !sawToolCalls) {
      content += delta.content;
      phraseBuffer += delta.content;
      const pulled = pullCompletedSpeechPhrases(phraseBuffer);
      phraseBuffer = pulled.rest;
      for (const phrase of pulled.phrases) {
        streamedSpeech = true;
        yield { type: "speech_delta", text: phrase };
      }
    }
  }

  if (!sawToolCalls && phraseBuffer.trim()) {
    streamedSpeech = true;
    yield { type: "speech_delta", text: phraseBuffer.trim() };
  }

  const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [...toolCallAcc.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, tc]) => Boolean(tc.name))
    .map(([, tc]) => ({
      id: tc.id || `call_${tc.name}`,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments || "{}" },
    }));

  yield {
    type: "round",
    round: {
      content,
      toolCalls,
      finishReason: finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
      streamedSpeech: streamedSpeech && !sawToolCalls,
    },
  };
}

function isToolName(name: string): name is LlmToolName {
  return normalizeLlmToolName(name) != null;
}

function toToolArgsRecord(rawArgs: Record<string, unknown>): Record<string, string> {
  const safeArgs: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawArgs)) {
    safeArgs[key] = String(value ?? "").trim();
  }
  return safeArgs;
}

function inferResponseType(
  speech: string,
  executions: LlmToolExecutionRecord[],
): FinalResponseType {
  const last = executions[executions.length - 1];
  if (!last) {
    if (/\border number\b/i.test(speech)) return "clarification_question";
    return "general_help";
  }

  if (last.tool === "get_shopify_order_status") {
    if (last.ok) return "order_found";
    if (
      last.status === "api_error" ||
      last.status === "system_maintenance" ||
      last.status === "throttled"
    ) {
      return "order_api_error";
    }
    return "order_not_found";
  }

  if (last.ok) return "confirmed_product";
  if (
    last.status === "api_error" ||
    last.status === "system_maintenance" ||
    last.status === "throttled"
  ) {
    return "catalog_degraded";
  }
  return "not_found";
}

function extractRecordMeta(
  executions: LlmToolExecutionRecord[],
): Pick<LlmAgentTurnResult, "recordOrderNumber" | "recordProduct"> {
  const lastOrder = [...executions]
    .reverse()
    .find((exec) => exec.tool === "get_shopify_order_status");
  if (lastOrder?.data && "status" in lastOrder.data) {
    const attempted =
      ("orderNumber" in lastOrder.data && typeof lastOrder.data.orderNumber === "string"
        ? lastOrder.data.orderNumber
        : null) ??
      lastOrder.args.orderNumber;
    if (attempted) {
      return { recordOrderNumber: attempted };
    }
  }

  const last = executions[executions.length - 1];
  if (!last?.data) return {};

  if ("bookName" in last.data && last.data.bookName) {
    return {
      recordProduct: {
        id: last.data.productId ?? "unknown",
        title: last.data.bookName,
      },
    };
  }

  return {};
}

/**
 * Dynamic system-message factory — rebuilt on each turn and mid-call after
 * verify_caller_challenge unlocks shipping / ledger disclosure.
 */
function buildDynamicSystemMessages(
  input: LlmAgentTurnInput,
  options?: { consumePendingNotes?: boolean },
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const consumePending = options?.consumePendingNotes !== false;
  const systemMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SHOSHAN_SYSTEM_PROMPT },
  ];

  const liveOrderContext =
    (input.session ? getActiveOrderContext(input.session) : undefined) ??
    input.activeOrderContext;

  if (
    liveOrderContext &&
    Object.keys(liveOrderContext).length > 0 &&
    hasConfirmedOrderContext(input.session)
  ) {
    const active = getOrCreateActiveSession(input.callSid);
    const verified = input.session?.isVerifiedCaller === true;
    const orderContext = filterOrderContextForVerification(
      redactTrackingFromOrderContext(liveOrderContext, active.isNotepadReady),
      verified,
    );
    const catalogPivot = isCatalogBuyPivotUtterance(
      input.userMessage,
      input.session ?? undefined,
    );
    systemMessages.push({
      role: "system",
      content: buildActiveOrderContextSystemMessage(orderContext, { catalogPivot }),
    });
  }

  if (input.session) {
    const vaultMessage = buildVaultSecuritySystemMessage(input.session);
    if (vaultMessage) {
      systemMessages.push({ role: "system", content: vaultMessage });
    }

    const memory = getSessionMemory(input.session) ?? ensureSessionMemory(input.session);

    // Structured Shopify schema injection (ledger / subscription / attachments / gate).
    for (const block of buildOrderContextStructuredSystemMessages(
      input.session,
      liveOrderContext ?? null,
    )) {
      systemMessages.push({ role: "system", content: block });
    }

    // Track Conversation Turns: if we just asked How many copies?, arm Confirmation Turn.
    if (lastAssistantAskedForQuantity(input.messages)) {
      memory.awaitingQuantityReply = true;
      memory.quantityAskCount = (memory.quantityAskCount ?? 0) + 1;
    }

    const quantityIntent = applySemanticQuantityIntentResolver(input);
    if (quantityIntent.systemNote) {
      systemMessages.push({ role: "system", content: quantityIntent.systemNote });
    }

    if (input.session.greetedThisCall) {
      systemMessages.push({
        role: "system",
        content:
          "TWIML GREETING ALREADY SPOKEN: The caller already heard the opening greeting on this call. Do NOT re-introduce yourself or list services. Respond only to their current message.",
      });
    }

    if (consumePending && input.session.pendingLlmSystemNote) {
      systemMessages.push({
        role: "system",
        content: input.session.pendingLlmSystemNote,
      });
      // One-shot — consumed after injection so it cannot sticky-loop forever.
      input.session.pendingLlmSystemNote = undefined;
    }

    if (input.session.welcomeBack) {
      systemMessages.push({
        role: "system",
        content: buildCallerWelcomeBackSystemMessage(),
      });
    }

    systemMessages.push({
      role: "system",
      content: buildCartContextSystemMessage(input.session),
    });

    const catalogTargetMessage = buildCatalogTargetSystemMessage(input.session);
    if (catalogTargetMessage) {
      systemMessages.push({ role: "system", content: catalogTargetMessage });
    }

    const lockedFlowMessage = buildLockedFlowSystemMessage(input.session);
    if (lockedFlowMessage) {
      systemMessages.push({ role: "system", content: lockedFlowMessage });
    }

    systemMessages.push({
      role: "system",
      content: buildActiveSessionSystemMessage(getOrCreateActiveSession(input.callSid)),
    });

    const emailConfirmMessage = buildEmailConfirmationSystemMessage(input.session);
    if (emailConfirmMessage) {
      systemMessages.push({ role: "system", content: emailConfirmMessage });
    }
  }

  return systemMessages;
}

/**
 * After verify_caller_challenge succeeds, splice a fresh system prefix onto the
 * live tool-loop messages so the next model round sees unredacted ledger/shipping.
 */
function spliceDynamicSystemMessagesAfterUnlock(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  input: LlmAgentTurnInput,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (input.session) {
    const refreshed = getActiveOrderContext(input.session);
    if (refreshed && Object.keys(refreshed).length > 0) {
      input.activeOrderContext = refreshed;
    }
  }
  const freshSystem = buildDynamicSystemMessages(input, { consumePendingNotes: false });
  const firstNonSystem = messages.findIndex((m) => m.role !== "system");
  const tail =
    firstNonSystem >= 0 ? messages.slice(firstNonSystem) : ([] as OpenAI.Chat.ChatCompletionMessageParam[]);
  return [...freshSystem, ...tail];
}

function buildOpenAiMessages(
  input: LlmAgentTurnInput,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const history = input.messages.slice(0, -1).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  return [
    ...buildDynamicSystemMessages(input),
    ...history,
    { role: "user", content: input.userMessage },
  ];
}

/** @internal Exported for unit tests — verifies invisible order context injection. */
export function buildLlmTurnMessagesForTest(
  input: LlmAgentTurnInput,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return buildOpenAiMessages(input);
}

function resolveToolsForTurn(input: LlmAgentTurnInput): OpenAI.Chat.ChatCompletionTool[] {
  if (!shouldOfferEndCallTool(input)) {
    return SHOPIFY_LLM_TOOLS.filter((tool) => tool.function?.name !== "end_call");
  }
  return SHOPIFY_LLM_TOOLS;
}

function ensureCatalogPivotClearsTracking(input: LlmAgentTurnInput): void {
  if (!input.session) return;
  const intent = resolveCallerIntent(input.userMessage, input.session);
  if (intent !== "catalog" && intent !== "cart") return;
  releaseTrackingFlowForIntentSwitch(input.callSid, { pivotToCatalog: true });
}

function mapToolToIntentKey(tool: LlmToolName): string | null {
  if (tool === "get_shopify_order_status") return "order";
  if (tool === "dictate_tracking") return "tracking";
  if (tool === "search_shopify_book_by_title" || tool === "search_shopify_book_by_isbn") {
    return "catalog";
  }
  if (tool === "get_cart_summary" || tool === "update_cart_item_quantity") {
    return "cart";
  }
  if (tool === "send_checkout_email") return "checkout";
  return null;
}

function lastAssistantAskedForOrder(messages: LlmChatMessage[]): boolean {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  return Boolean(
    last &&
      /order\s*(?:number|#)|what(?:'s| is) your order|tell me (?:your |the )?order/i.test(
        last.content,
      ),
  );
}

/**
 * Semantic Intent Resolver — preprocess user input before the LLM.
 * Maps "one" / "just one" / "a single copy" → integer 1 and annotates the turn
 * so the model cannot re-ask How many copies? (Verification Over-Constraint).
 */
function applySemanticQuantityIntentResolver(input: LlmAgentTurnInput): {
  resolvedQuantity: number | null;
  systemNote: string | null;
} {
  if (!isBareQuantityReply(input.userMessage)) {
    return { resolvedQuantity: null, systemNote: null };
  }
  const resolvedQuantity = mapNaturalLanguageToInteger(input.userMessage);
  if (resolvedQuantity == null) {
    return { resolvedQuantity: null, systemNote: null };
  }

  const session = input.session;
  if (!session?.lastCatalogSearch?.variantId) {
    return { resolvedQuantity, systemNote: null };
  }

  const memory = getSessionMemory(session);
  const alreadyInCart = (session.shoppingCart ?? []).some(
    (line) => line.variantId === session.lastCatalogSearch?.variantId,
  );
  const asked =
    lastAssistantAskedForQuantity(input.messages) ||
    memory.awaitingQuantityReply === true ||
    (memory.quantityAskCount ?? 0) > 0 ||
    !alreadyInCart;

  if (!asked) {
    return { resolvedQuantity, systemNote: null };
  }

  memory.awaitingQuantityReply = true;
  memory.latestQuantityRequested = resolvedQuantity;

  const title = session.lastCatalogSearch.title?.trim() || "the book you just found";
  return {
    resolvedQuantity,
    systemNote: [
      "SEMANTIC INTENT RESOLVER (MANDATORY — NO RE-ASK LOOP):",
      `The caller answered a quantity question with natural language. Mapped utterance → quantity=${resolvedQuantity}.`,
      `This is a Confirmation Turn. Immediately call update_cart_item_quantity with action_type=set (or add if the line is new), quantity=${resolvedQuantity}, and the last catalog variant for "${title}".`,
      "Acknowledge once and proceed to the shopping loop / payment-link offer. Do NOT ask 'How many copies?' again. Do NOT ask 'are you sure?'.",
    ].join(" "),
  };
}

function isAwaitingOrderNumberSlot(input: LlmAgentTurnInput): boolean {
  if (lastAssistantAskedForOrder(input.messages)) return true;
  const session = input.session;
  if (!session) return false;
  return (
    session.awaitingInput === "order_number" ||
    session.phase === "awaiting_order_number"
  );
}

/** Digit-only / spoken-digit utterance that is clearly an order number, not an ISBN. */
function isBareOrderNumberUtterance(text: string): boolean {
  const trimmed = text.trim();
  if (/^\d{4,10}(-[a-z0-9]{1,6})?$/i.test(trimmed)) return true;
  if (/^#?\d{4,10}(?:-[a-z0-9]{1,6})?$/i.test(trimmed)) return true;
  // Spoken digits only (e.g. "two one six nine eight") — reject ISBN-length 10/13.
  const fromSpeech = extractOrderNumberFromSpeech(trimmed);
  if (!fromSpeech) return false;
  const digits = fromSpeech.replace(/\D/g, "");
  return digits.length >= 4 && digits.length <= 10 && !/\bisbn\b/i.test(trimmed);
}

function isCatalogBuyPivotUtterance(text: string, session?: CallSession): boolean {
  if (isCatalogShoppingUtterance(text)) return true;
  const intent = resolveCallerIntent(text, session);
  if (intent === "catalog" || intent === "cart") return true;
  if (extractIsbnFromSpeech(text)) return true;
  return /\b(buy|purchase|isbn|looking\s+for\s+(?:a\s+)?book|add\s+to\s+cart|search\s+for\s+(?:a\s+)?book|book\s+(?:called|titled|named)|title\s+is|find\s+(?:me\s+)?(?:a\s+)?book)\b/i.test(
    text,
  );
}

function isLikelyIsbnDigits(value: string, utterance: string): boolean {
  const digitsOnly = value.replace(/\D/g, "");
  if (digitsOnly.length !== 10 && digitsOnly.length !== 13) return false;
  return (
    Boolean(extractIsbnFromSpeech(utterance)) ||
    isValidIsbnFormat(digitsOnly) ||
    /\b(isbn|barcode|978|979)\b/i.test(utterance)
  );
}

function detectOrderNumberForForcedLookup(input: LlmAgentTurnInput): string | null {
  // Intent-first: never hijack a buy/catalog turn into order lookup speech.
  if (isCatalogBuyPivotUtterance(input.userMessage, input.session ?? undefined)) {
    return null;
  }

  // CONTEXT LOCK: mid-dictation spatial resumes are NOT a new order number.
  // Only apply when already in tracking dictation — bare order digits must still force lookup.
  const active = getOrCreateActiveSession(input.callSid);
  const inTrackingDictation =
    active.currentState === "tracking_dictation" ||
    (active.currentState === "awaiting_notepad_ready" && active.cachedIntent === "tracking") ||
    (active.cachedIntent === "tracking" && Boolean(active.lastSpokenPayload?.trackingForTts));
  if (inTrackingDictation && isSpatialResumeQuery(input.userMessage)) {
    return null;
  }
  if (inTrackingDictation && isBareOrderNumberUtterance(input.userMessage)) {
    // Digits during active tracking dictation are anchors / confirmations, not new orders.
    return null;
  }

  const insistence = isOrderLookupInsistenceUtterance(input.userMessage);

  if (insistence) {
    const insisted =
      extractOrderNumberFromStt(input.userMessage, { awaitingSlot: true }) ??
      extractOrderNumberFromSpeech(input.userMessage);
    if (insisted && !isLikelyIsbnDigits(insisted, input.userMessage)) {
      return insisted;
    }
    return null;
  }

  const awaitingSlot = isAwaitingOrderNumberSlot(input);
  const bareOrder = isBareOrderNumberUtterance(input.userMessage);
  const allowLoose = awaitingSlot || bareOrder;

  const orderNumber =
    (allowLoose ? extractOrderNumberFromSpeech(input.userMessage) : null) ??
    extractOrderNumberFromStt(input.userMessage, { awaitingSlot: allowLoose });

  if (!orderNumber) return null;

  if (isLikelyIsbnDigits(orderNumber, input.userMessage)) {
    return null;
  }

  const agentState = getAgentState(input.callSid);
  const orderAlreadyFound =
    !insistence &&
    (shouldBlockOrderLookupReinvoke(input.session, orderNumber) ||
      (Boolean(input.activeOrderContext && Object.keys(input.activeOrderContext).length > 0) &&
        agentState.lastOrderNumber &&
        orderNumbersMatch(agentState.lastOrderNumber, orderNumber)));
  if (orderAlreadyFound) {
    return null;
  }

  if (isAwaitingOrderNumberSlot(input)) {
    return orderNumber;
  }

  const lower = input.userMessage.toLowerCase();
  const hasOrderIntent =
    bareOrder ||
    /\b(order\s+number|track\s+(?:my\s+)?order|order\s+status|lookup\s+(?:my\s+)?order|check\s+(?:my\s+)?order)\b/i.test(
      lower,
    ) ||
    (/\border\b/i.test(lower) &&
      (/\b(number|status|track|lookup|check|find)\b/i.test(lower) || /\d{4,}/.test(lower)));

  return hasOrderIntent ? orderNumber : null;
}

const LLM_FALLBACK_SPEECH =
  "Sorry, I didn't catch that. Do you have an order number, or are you looking for a book?";

/** Deterministic responses when the LLM is unavailable (quota, timeout, outage). */
function resolveDeterministicTurnFallback(input: LlmAgentTurnInput): LlmAgentTurnResult {
  const greeting = interceptGreetingBeforeLlm(input);
  if (greeting) return greeting;

  const orderOffer = interceptOrderNumberOfferBeforeLlm(input);
  if (orderOffer) return orderOffer;

  if (isSocialGreetingUtterance(input.userMessage)) {
    return {
      speech: buildGreetingResponse(input.userMessage),
      toolExecutions: [],
      responseType: "general_help",
    };
  }

  if (isOrderNumberOfferUtterance(input.userMessage)) {
    if (input.session) {
      input.session.phase = "awaiting_order_number";
      input.session.awaitingInput = "order_number";
    }
    return {
      speech: buildOrderNumberOfferResponse(),
      toolExecutions: [],
      responseType: "clarification_question",
    };
  }

  const lower = input.userMessage.toLowerCase();
  if (
    /\b(where\s+is\s+my\s+order|order\s+status|track\s+my\s+order|check\s+my\s+order)\b/i.test(
      lower,
    ) &&
    !extractOrderNumberFromSpeech(input.userMessage)
  ) {
    if (input.session) {
      input.session.phase = "awaiting_order_number";
      input.session.awaitingInput = "order_number";
    }
    return {
      speech: buildClarifyingResponse(),
      toolExecutions: [],
      responseType: "clarification_question",
    };
  }

  return {
    speech: softFallback(input.userMessage),
    toolExecutions: [],
    responseType: "general_help",
  };
}

/** Caller signals they have an order number but hasn't spoken digits yet. */
function interceptGreetingBeforeLlm(input: LlmAgentTurnInput): LlmAgentTurnResult | null {
  if (!isSocialGreetingUtterance(input.userMessage)) return null;
  if (isAwaitingOrderNumberSlot(input)) return null;

  return {
    speech: buildGreetingResponse(input.userMessage),
    toolExecutions: [],
    responseType: "general_help",
  };
}

function interceptOrderNumberOfferBeforeLlm(
  input: LlmAgentTurnInput,
): LlmAgentTurnResult | null {
  const text = input.userMessage.trim();
  if (!text) return null;

  // Too-short bare digits (e.g. "222") — ask for the full order number once.
  if (/^\d{1,3}$/.test(text)) {
    if (input.session) {
      input.session.phase = "awaiting_order_number";
      input.session.awaitingInput = "order_number";
    }
    return {
      speech: "I need the full order number — it's usually four to six digits. What's your order number?",
      toolExecutions: [],
      responseType: "clarification_question",
    };
  }

  // Already contains a valid order number → forced lookup handles it.
  if (extractOrderNumberFromSpeech(text) || extractOrderNumberFromStt(text, { awaitingSlot: true })) {
    return null;
  }
  if (
    !/\b(?:i\s+have\s+(?:an?\s+|my\s+|the\s+)?order(?:\s+number)?|have\s+(?:an?\s+|my\s+)?order\s+number|my\s+order\s+number\s+is|want\s+to\s+(?:check|look\s*up)\s+(?:my\s+)?order|check\s+(?:my\s+)?order|order\s+status)\b/i.test(
      text,
    )
  ) {
    return null;
  }

  if (input.session) {
    input.session.phase = "awaiting_order_number";
    input.session.awaitingInput = "order_number";
  }

  return {
    speech: "Perfect — go ahead and tell me your order number.",
    toolExecutions: [],
    responseType: "clarification_question",
  };
}

function groundedSpeechFromOrderToolRecord(
  record: LlmToolExecutionRecord,
  options?: { insistence?: boolean; session?: CallSession },
): string {
  if (record.status === "blocked") {
    return record.errorMessage ?? "What's your order number?";
  }
  if (
    record.tool === "get_shopify_order_status" &&
    record.data &&
    "status" in record.data
  ) {
    const data = record.data as {
      status?: string;
      message?: string;
      orderView?: { order_number?: string; customer_name?: string; fulfillment_status?: string };
      searchedNumber?: string;
    };
    if (data.orderView) {
      return speechForOrderLookupResult(
        {
          status: data.status === "found" ? "found" : (data.status as OrderLookupStatus) ?? "not_found",
          orderNumber: data.orderView.order_number,
          customerName: data.orderView.customer_name,
          fulfillmentStatus: data.orderView.fulfillment_status,
          message: data.message,
          searchedNumber: data.searchedNumber,
        },
        options,
      );
    }
    return speechForOrderLookupResult(data, options);
  }
  if (
    record.status === "system_maintenance" ||
    record.status === "api_error" ||
    record.status === "throttled"
  ) {
    if (
      record.errorMessage === "Shopify API timeout" ||
      (record.data &&
        "message" in record.data &&
        record.data.message === "Shopify API timeout")
    ) {
      return SHOPIFY_TIMEOUT_SPOKEN;
    }
    return speechForOrderLookupResult(
      { status: record.status, message: record.errorMessage },
      options,
    );
  }
  return ORDER_NOT_FOUND_STRICT_SPOKEN;
}

function resultFromDictateTrackingExecution(
  record: LlmToolExecutionRecord,
  toolExecutions: LlmToolExecutionRecord[],
  callSid: string,
): LlmAgentTurnResult {
  const rawSpeech =
    record.ok && record.data && "tracking_number_for_tts" in record.data
      ? String(record.data.tracking_number_for_tts ?? "")
      : (record.errorMessage ?? NOTEPAD_HANDSHAKE_PROMPT);
  const speech = enforceNotepadGateOnSpeech(callSid, rawSpeech);
  return {
    speech,
    toolExecutions,
    responseType: record.ok ? "order_found" : "general_help",
  };
}

function resultFromOrderToolExecution(
  record: LlmToolExecutionRecord,
  toolExecutions: LlmToolExecutionRecord[],
  options?: { insistence?: boolean; session?: CallSession },
): LlmAgentTurnResult {
  const speech = groundedSpeechFromOrderToolRecord(record, options);
  return {
    speech,
    toolExecutions,
    responseType: inferResponseType(speech, toolExecutions),
    ...extractRecordMeta(toolExecutions),
  };
}

/**
 * Record deterministic assistant speech in LLM conversation history.
 * Required when TTS is built outside the LLM so the next turn retains context.
 */
export function syncDeterministicAssistantSpeech(
  callSid: string,
  assistantSpeech: string,
  meta: {
    responseType: FinalResponseType;
    recordOrderNumber?: string;
    recordProduct?: { id: string; title: string };
    finalizeToolExecution?: boolean;
  },
): void {
  const speech = assistantSpeech.trim();
  if (!speech) return;

  dispatchAgentEvent(callSid, {
    type: "RESPONSE_SENT",
    payload: {
      responseType: meta.responseType,
      speech,
      speechLength: speech.length,
      recordOrderNumber: meta.recordOrderNumber,
      recordProduct: meta.recordProduct,
      finalizeToolExecution: meta.finalizeToolExecution === true,
      fulfillmentFlow: true,
    },
  });

  logger.info("llm_assistant_turn_synced", {
    callSid: callSid.slice(0, 8),
    responseType: meta.responseType,
    speechLength: speech.length,
  });
}

/**
 * Run one caller turn with tool-pending events for system-level filler injection.
 */
function interceptOrderFieldQueryBeforeLlm(input: LlmAgentTurnInput): LlmAgentTurnResult | null {
  const callerIntent = resolveCallerIntent(input.userMessage, input.session ?? undefined);
  if (callerIntent === "catalog" || callerIntent === "cart") return null;
  if (!hasConfirmedOrderContext(input.session)) return null;

  const ctx = input.activeOrderContext;
  if (!ctx || Object.keys(ctx).length === 0) return null;
  if (!isOrderFieldQuestion(input.userMessage, input.session)) return null;

  const speech = appendProtocolClosing(
    buildOrderFieldQuerySpeech(input.userMessage, ctx) ?? "",
  );
  if (!speech.trim()) return null;

  return {
    speech,
    toolExecutions: [],
    responseType: "general_help",
  };
}

function interceptContextualDictationRepeatBeforeLlm(
  input: LlmAgentTurnInput,
): LlmAgentTurnResult | null {
  if (!isContextualDictationRepeatRequest(input.userMessage)) return null;

  const active = getOrCreateActiveSession(input.callSid);
  const trackingRaw =
    active.lastSpokenDataPoint?.kind === "tracking_number"
      ? active.lastSpokenDataPoint.raw
      : active.lastSpokenPayload?.trackingRaw ||
        getActiveOrderTrackingNumber(input.session);

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
      speech: promptUserForNotepad(),
      toolExecutions: [],
      responseType: "general_help",
    };
  }

  if (!active.lastSpokenPayload?.trackingForTts && trackingRaw) {
    ensureTrackingPayload(input.callSid, trackingRaw);
  }

  const slower = buildSlowerTrackingReplaySpeech(input.callSid);
  if (!slower) return null;

  return {
    speech: appendTrackingDictationConfirm(slower),
    toolExecutions: [],
    responseType: "order_found",
  };
}

function enforceNotepadGateOnSpeech(callSid: string, speech: string): string {
  const active = getOrCreateActiveSession(callSid);
  if (active.trackingDictationComplete) return speech;
  if (active.isNotepadReady) return speech;
  if (!active.lastSpokenPayload?.trackingForTts) return speech;
  if (isTrackingDictationText(speech)) {
    return promptUserForNotepad();
  }
  return speech;
}

export async function* runLlmAgentTurnEvents(
  input: LlmAgentTurnInput,
): AsyncGenerator<LlmAgentTurnEvent> {
  const stickyOrderAtTurnStart = isOrderLookupComplete(input.session);

  if (turnOverride) {
    try {
      const result = await turnOverride(input);
      if (result.toolExecutions.length > 0) {
        yield {
          type: "tool_pending",
          tools: result.toolExecutions.map((exec) => exec.tool),
        };
      }
      yield { type: "result", result };
      return;
    } catch (err) {
      logger.warn("llm_agent_turn_override_failed", {
        callSid: input.callSid.slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
      yield { type: "result", result: resolveDeterministicTurnFallback(input) };
      return;
    }
  }

  // Pre-turn LISTENING_WAIT is owned by VoicePreTurn (orchestrator / transport).
  // Adapter must not duplicate Wait-for-Clause ownership.

  // Tracking / notepad / spatial gating: ConversationOrchestrator.resolveTrackingPhaseGate only.
  ensureCatalogPivotClearsTracking(input);

  // Same order already sticky — acknowledge without re-fetching or re-speaking gateway.
  if (
    stickyOrderAtTurnStart &&
    input.session &&
    !isOrderLookupInsistenceUtterance(input.userMessage)
  ) {
    const mentioned =
      extractOrderNumberFromStt(input.userMessage, { awaitingSlot: true }) ??
      extractOrderNumberFromSpeech(input.userMessage);
    if (
      mentioned &&
      shouldBlockOrderLookupReinvoke(input.session, mentioned) &&
      !isTrackingRequest(input.userMessage) &&
      !isOrderFieldQuestion(input.userMessage) &&
      !isRefundNotificationEmailQuestion(input.userMessage)
    ) {
      yield {
        type: "result",
        result: {
          speech: buildStickyOrderStillOpenSpeech(getCurrentSessionOrderNumber(input.session)),
          toolExecutions: [],
          responseType: "order_found",
        },
      };
      return;
    }
  }

  const forcedOrderNumber = detectOrderNumberForForcedLookup(input);
  if (forcedOrderNumber) {
    if (
      input.session &&
      shouldBlockOrderLookupReinvoke(input.session, forcedOrderNumber)
    ) {
      yield {
        type: "result",
        result: {
          speech: buildStickyOrderStillOpenSpeech(getCurrentSessionOrderNumber(input.session)),
          toolExecutions: [],
          responseType: "order_found",
        },
      };
      return;
    }
    const insistence = isOrderLookupInsistenceUtterance(input.userMessage);
    if (input.session) {
      // Always keep miss/retry turns in the order-number slot so bypassCache works.
      input.session.phase = "awaiting_order_number";
      input.session.awaitingInput = "order_number";
    }
    yield { type: "tool_pending", tools: ["get_shopify_order_status"] };
    const record = await ServiceRegistry.executeTool(
      "get_shopify_order_status",
      {
        orderNumber: forcedOrderNumber,
        bypassCache: "true",
      },
      input.callSid,
      input.session,
    );
    yield {
      type: "result",
      result: resultFromOrderToolExecution(record, [record], {
        insistence,
        session: input.session,
      }),
    };
    return;
  }

  const orderOfferIntercept = interceptOrderNumberOfferBeforeLlm(input);
  if (orderOfferIntercept) {
    yield { type: "result", result: orderOfferIntercept };
    return;
  }

  const greetingIntercept = interceptGreetingBeforeLlm(input);
  if (greetingIntercept) {
    yield { type: "result", result: greetingIntercept };
    return;
  }

  if (isOutOfDomainQuestion(input.userMessage)) {
    const speech = buildPolitePivotSpeech(input.userMessage);
    yield {
      type: "result",
      result: {
        speech,
        toolExecutions: [],
        responseType: "general_help",
      },
    };
    return;
  }

  ensureCatalogPivotClearsTracking(input);

  const contextualRepeat = interceptContextualDictationRepeatBeforeLlm(input);
  if (contextualRepeat) {
    yield { type: "result", result: contextualRepeat };
    return;
  }

  const orderFieldIntercept = interceptOrderFieldQueryBeforeLlm(input);
  if (orderFieldIntercept) {
    yield { type: "result", result: orderFieldIntercept };
    return;
  }

  if (
    isClosingConversationUtterance(input.userMessage, input.messages, input.session) &&
    !isPaymentLinkActionUtterance(input.userMessage)
  ) {
    yield {
      type: "result",
      result: {
        speech: SURESHOT_GOODBYE_SPEECH,
        toolExecutions: [
          {
            tool: "end_call",
            args: {},
            ok: true,
            status: "ok",
            elapsedMs: 0,
          },
        ],
        responseType: "general_help",
        endCall: true,
      },
    };
    return;
  }

  if (
    input.activeOrderContext &&
    Object.keys(input.activeOrderContext).length > 0 &&
    hasConfirmedOrderContext(input.session) &&
    isRefundNotificationEmailQuestion(input.userMessage)
  ) {
    const speech = buildRefundEmailFollowUpSpeech(input.activeOrderContext, input.userMessage);
    yield {
      type: "result",
      result: {
        speech,
        toolExecutions: [],
        responseType: "general_help",
      },
    };
    return;
  }

  const toolExecutions: LlmToolExecutionRecord[] = [];
  let messages: OpenAI.Chat.ChatCompletionMessageParam[] = buildOpenAiMessages(input);

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      if (isTurnAborted(input.callSid)) {
        break;
      }

      let streamedRound: StreamedAssistantRound | undefined;
      for await (const streamEvent of streamAssistantRound(messages, input)) {
        if (streamEvent.type === "speech_delta") {
          yield { type: "speech_delta", text: streamEvent.text };
          continue;
        }
        streamedRound = streamEvent.round;
      }

      if (!streamedRound) break;

      const toolCalls = streamedRound.toolCalls;
      const finishReason = streamedRound.finishReason;
      const messageContent = streamedRound.content;

      if (toolCalls.length > 0 && finishReason === "tool_calls") {
        yield {
          type: "tool_pending",
          tools: toolCalls
            .filter((c): c is OpenAI.Chat.ChatCompletionMessageToolCall & { type: "function" } =>
              c.type === "function" && isToolName(c.function.name),
            )
            .map((c) => c.function.name as LlmToolName),
        };

        messages = [
          ...messages,
          {
            role: "assistant",
            content: messageContent ?? "",
            tool_calls: toolCalls,
          },
        ];

        for (const call of toolCalls) {
          if (isTurnAborted(input.callSid)) {
            break;
          }
          if (call.type !== "function" || !isToolName(call.function.name)) {
            continue;
          }

          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
          } catch {
            parsedArgs = {};
          }

          const batchHasCartTools = toolCalls.some(
            (candidate) =>
              candidate.type === "function" &&
              (candidate.function.name === "update_cart_item_quantity" ||
                candidate.function.name === "get_cart_summary"),
          );

          if (call.function.name === "end_call") {
            if (
              batchHasCartTools ||
              shouldBlockPrematureEndCall({
                userMessage: input.userMessage,
                messages: input.messages,
                toolExecutions,
                session: input.session,
              })
            ) {
              toolExecutions.push({
                tool: "end_call",
                args: toToolArgsRecord(parsedArgs),
                ok: false,
                status: "blocked",
                elapsedMs: 0,
                errorMessage:
                  "GLOBAL ANTI-HANGUP: end_call blocked. Continue helping the caller — never hang up from confusion, missing data, or frustration. Only end_call after an explicit goodbye or when they clearly decline further help.",
              });
              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: JSON.stringify({
                  status: "blocked",
                  error:
                    "GLOBAL ANTI-HANGUP: end_call blocked. Continue helping the caller unless they explicitly said goodbye, no thank you, or declined further help after you asked if they need anything else.",
                }),
              });
              continue;
            }
          }

          const active = getOrCreateActiveSession(input.callSid);
          const intentKey = mapToolToIntentKey(call.function.name);
          const filteredContext =
            input.activeOrderContext && Object.keys(input.activeOrderContext).length > 0
              ? filterOrderContextForVerification(
                  input.activeOrderContext,
                  input.session?.isVerifiedCaller === true,
                )
              : undefined;
          if (
            intentKey &&
            shouldSkipToolReinvoke(active, intentKey, call.function.name, {
              userMessage: input.userMessage,
              orderContext: filteredContext,
              session: input.session,
              requestedOrderNumber:
                typeof parsedArgs.orderNumber === "string"
                  ? parsedArgs.orderNumber
                  : undefined,
            })
          ) {
            const cachedOrderPayload =
              call.function.name === "get_shopify_order_status" && filteredContext
                ? {
                    status: "FOUND",
                    found: true,
                    order_lookup_complete: true,
                    data: filteredContext,
                    instructions:
                      "CONTEXT LOCK: order_lookup_complete is true. Do NOT call get_shopify_order_status again. Answer ONLY from this cached JSON. Obey STRICT CONVERSATIONAL ECONOMY — disclose fields only when the caller asks.",
                  }
                : {
                    status: "CACHED",
                    source: "ActiveSession",
                    instructions:
                      "Do NOT re-fetch. Use lastSpokenPayload from SOVEREIGN ACTIVE SESSION. Obey SILENCE PROTOCOL unless caller said 'full summary'.",
                    lastSpoken: active.lastSpokenPayload,
                  };
            toolExecutions.push({
              tool: call.function.name,
              args: toToolArgsRecord(parsedArgs),
              ok: true,
              status: "ok",
              elapsedMs: 0,
            });
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(cachedOrderPayload),
            });
            continue;
          }

          const generation = getTurnGeneration(input.callSid);
          const canonicalTool = normalizeLlmToolName(call.function.name) ?? call.function.name;
          const record = await ServiceRegistry.executeTool(
            canonicalTool,
            parsedArgs,
            input.callSid,
            input.session,
          );

          if (
            isStaleTurnGeneration(input.callSid, generation) ||
            record.errorMessage === "Turn aborted — tool result discarded"
          ) {
            logger.info("llm_tool_result_discarded_after_barge_in", {
              callSid: input.callSid.slice(0, 8),
              tool: call.function.name,
            });
            // Drop late tool output so it cannot corrupt UnifiedCallSession / TTS.
            return;
          }

          toolExecutions.push(record);

          const toolContent = toolResultForLlm(record, {
            isVerifiedCaller: input.session?.isVerifiedCaller === true,
            session: input.session,
          });

          if (
            record.status === "api_error" ||
            record.status === "system_maintenance" ||
            record.status === "throttled"
          ) {
            logger.warn("llm_tool_error_surfaced_to_brain", {
              callSid: input.callSid.slice(0, 8),
              tool: call.function.name,
              status: record.status,
              errorMessage: record.errorMessage ?? null,
            });
          }

          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: toolContent,
          });

          // Mid-call state unlock: rebuild system prefix with unredacted ledger/shipping.
          if (
            call.function.name === "verify_caller_challenge" &&
            record.ok &&
            input.session?.isVerifiedCaller === true
          ) {
            messages = spliceDynamicSystemMessagesAfterUnlock(messages, input);
            logger.info("verification_challenge_prompt_rebuilt", {
              callSid: input.callSid.slice(0, 8),
              verified: true,
            });
          }
        }

        if (isTurnAborted(input.callSid)) {
          return;
        }
        const lastCatalogExec = [...toolExecutions].reverse().find(
          (exec) =>
            exec.tool === "search_shopify_book_by_title" ||
            exec.tool === "search_shopify_book_by_isbn" ||
            exec.tool === "update_cart_item_quantity" ||
            exec.tool === "send_checkout_email",
        );
        const lastOrderExec = [...toolExecutions]
          .reverse()
          .find((exec) => exec.tool === "get_shopify_order_status");
        // Catalog/buy tools win when the caller pivoted away from order status.
        // Sticky follow-ups: never re-speak Concierge Gateway — let LLM / dictate answer the field.
        if (lastOrderExec && !lastCatalogExec && !stickyOrderAtTurnStart) {
          yield {
            type: "result",
            result: resultFromOrderToolExecution(lastOrderExec, toolExecutions, {
              session: input.session,
            }),
          };
          return;
        }

        const dictateExec = [...toolExecutions]
          .reverse()
          .find((exec) => exec.tool === "dictate_tracking");
        if (dictateExec) {
          yield {
            type: "result",
            result: resultFromDictateTrackingExecution(dictateExec, toolExecutions, input.callSid),
          };
          return;
        }

        const endCallExec = toolExecutions.find(
          (exec) => exec.tool === "end_call" && exec.ok,
        );
        if (endCallExec) {
          yield {
            type: "result",
            result: {
              speech: (messageContent ?? "").trim() || SURESHOT_GOODBYE_SPEECH,
              toolExecutions,
              responseType: "general_help",
              endCall: true,
            },
          };
          return;
        }

        const blockedEndCall = toolExecutions.some(
          (exec) => exec.tool === "end_call" && exec.status === "blocked",
        );
        if (blockedEndCall) {
          continue;
        }

        continue;
      }

      let speech = (messageContent ?? "").trim();
      if (speech) {
        speech = stripRoboticAssistantSpeech(speech, input.userMessage);
        speech = enforceNotepadGateOnSpeech(input.callSid, speech);
        speech = await ensureUniqueSpokenResponse(input.callSid, speech, input.userMessage);
        const responseType = inferResponseType(speech, toolExecutions);
        const endCall = toolExecutions.some((t) => t.tool === "end_call" && t.ok);
        // When tokens were already streamed as speech_delta, still emit result for session sync.
        yield {
          type: "result",
          result: {
            speech,
            toolExecutions,
            responseType,
            endCall,
            ...extractRecordMeta(toolExecutions),
          },
        };
        return;
      }

      break;
    }
  } catch (err) {
    logger.warn("llm_agent_turn_failed", {
      callSid: input.callSid.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  yield {
    type: "result",
    result: resolveDeterministicTurnFallback(input),
  };
}

/**
 * Run one caller turn: LLM may issue tool calls, receive Shopify JSON, then synthesize TTS.
 */
export async function runLlmAgentTurn(
  input: LlmAgentTurnInput,
): Promise<LlmAgentTurnResult> {
  let last: LlmAgentTurnResult | undefined;
  for await (const event of runLlmAgentTurnEvents(input)) {
    if (event.type === "result") {
      last = event.result;
    }
  }

  return last ?? resolveDeterministicTurnFallback(input);
}
