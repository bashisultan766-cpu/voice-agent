/**
 * OpenAI tool-calling adapter — ElevenLabs-style fluid dialogue with Shopify tools.
 */
import OpenAI from "openai";
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { SHOSHAN_SYSTEM_PROMPT } from "../prompts/systemPrompt.js";
import {
  toolResultForLlm,
  type LlmToolExecutionRecord,
  type LlmToolName,
} from "./llmToolExecutor.js";
import { UNIFIED_OPENAI_TOOL_SCHEMAS } from "./unifiedToolRegistry.js";
import type { OrderStatusResult } from "./shopifyStorefrontAdapter.js";
import { ServiceRegistry } from "../sovereign/serviceRegistry.js";
import {
  isOrderLookupInsistenceUtterance,
  speechForOrderLookupResult,
} from "../agents/orderLookupWorkflow.js";
import { LLM_ORCHESTRATOR_TEMPERATURE } from "../agents/llmConfig.js";
import { extractOrderNumberFromStt } from "../nlp/entityExtractor.js";
import { ORDER_NOT_FOUND_STRICT_SPOKEN } from "../constants/systemMessages.js";
import { dispatchAgentEvent, getAgentState } from "../platform/eventDispatcher.js";
import { extractOrderNumberFromSpeech, orderNumbersMatch } from "../utils/formatter.js";
import { buildPolitePivotSpeech, isOutOfDomainQuestion } from "../utils/domainGuard.js";
import { buildActiveOrderContextSystemMessage, redactTrackingFromOrderContext } from "../agents/sessionManager.js";
import { filterOrderContextForVerification } from "../agents/orderContextPrivacy.js";
import type { ActiveOrderContextData } from "../agents/sessionManager.js";
import { buildCartContextSystemMessage } from "../agents/cartManager.js";
import { buildCatalogTargetSystemMessage } from "../agents/catalogTarget.js";
import { hasConfirmedOrderContext } from "../agents/orderContextPolicy.js";
import { buildVaultSecuritySystemMessage } from "../agents/callerVerification.js";
import type { CallSession } from "../types/order.js";
import {
  appendProtocolClosing,
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
import { getTurnAbortSignal, isTurnAborted } from "../runtime/turnAbortRegistry.js";
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
} from "../sovereign/activeSession.js";
import { NOTEPAD_HANDSHAKE_PROMPT } from "../sovereign/sovereignRouter.js";
import {
  isTrackingRequest,
  hasTrackingInSessionContext,
  isTrackingDictationCompleteIntent,
  shouldStartTrackingDictation,
  type TrackingDictationGateContext,
} from "../agents/trackingIntent.js";
import { resolveDictateTracking } from "../sovereign/dictateTrackingGate.js";
import { isSpatialResumeQuery, resolveSpatialTurnSpeech } from "../sovereign/spatialDictation.js";
import {
  promptUserForNotepad,
  completeTrackingDictation,
  TRACKING_DICTATION_COMPLETE_SPEECH,
  isUserNotepadReadyIntent,
  beginTrackingDictationAfterNotepadReady,
  isTrackingDictationPending,
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
  /** Injected on follow-up turns — full order JSON not spoken during progressive disclosure. */
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
 */
async function* streamAssistantRound(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  input: LlmAgentTurnInput,
): AsyncGenerator<
  { type: "speech_delta"; text: string } | { type: "round"; round: StreamedAssistantRound }
> {
  const signal = getTurnAbortSignal(input.callSid);
  const stream = await getClient().chat.completions.create(
    {
      model: getConfig().CONVERSATION_BRAIN_MODEL,
      temperature: LLM_ORCHESTRATOR_TEMPERATURE,
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
  return (
    name === "get_shopify_order_status" ||
    name === "get_customer_history" ||
    name === "search_shopify_book_by_isbn" ||
    name === "search_shopify_book_by_title" ||
    name === "dictate_tracking" ||
    name === "add_to_cart" ||
    name === "remove_from_cart" ||
    name === "get_cart_summary" ||
    name === "send_checkout_email" ||
    name === "send_support_escalation" ||
    name === "end_call"
  );
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

function buildOpenAiMessages(
  input: LlmAgentTurnInput,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const history = input.messages.slice(0, -1).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const systemMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SHOSHAN_SYSTEM_PROMPT },
  ];

  if (
    input.activeOrderContext &&
    Object.keys(input.activeOrderContext).length > 0 &&
    hasConfirmedOrderContext(input.session)
  ) {
    const active = getOrCreateActiveSession(input.callSid);
    const verified = input.session?.isVerifiedCaller === true;
    const orderContext = filterOrderContextForVerification(
      redactTrackingFromOrderContext(input.activeOrderContext, active.isNotepadReady),
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

    if (input.session.greetedThisCall) {
      systemMessages.push({
        role: "system",
        content:
          "TWIML GREETING ALREADY SPOKEN: The caller already heard the opening greeting on this call. Do NOT re-introduce yourself or list services. Respond only to their current message.",
      });
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
  }

  return [
    ...systemMessages,
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
  if (tool === "get_cart_summary" || tool === "add_to_cart" || tool === "remove_from_cart") {
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
    Boolean(input.activeOrderContext && Object.keys(input.activeOrderContext).length > 0) &&
    agentState.lastOrderNumber &&
    orderNumbersMatch(agentState.lastOrderNumber, orderNumber);
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
    (/\border\b/i.test(lower) && /\b(number|status|track|lookup|check|find)\b/i.test(lower));

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
    return speechForOrderLookupResult(record.data as OrderStatusResult, options);
  }
  if (
    record.status === "system_maintenance" ||
    record.status === "api_error" ||
    record.status === "throttled"
  ) {
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

function interceptNotepadReadyBeforeLlm(input: LlmAgentTurnInput): LlmAgentTurnResult | null {
  if (!isUserNotepadReadyIntent(input.userMessage, input.callSid)) return null;

  const trackingRaw = String(input.session?.currentOrderData?.tracking_number ?? "").trim();
  const active = getOrCreateActiveSession(input.callSid);
  if (!active.lastSpokenPayload?.trackingForTts && trackingRaw) {
    ensureTrackingPayload(input.callSid, trackingRaw);
  }
  if (
    !isTrackingDictationPending(input.callSid, input.session?.currentOrderData) ||
    !getOrCreateActiveSession(input.callSid).lastSpokenPayload?.trackingForTts
  ) {
    return null;
  }

  const turn = beginTrackingDictationAfterNotepadReady(input.callSid);
  return {
    speech: turn.speech,
    toolExecutions: [],
    responseType: turn.ok ? "order_found" : "general_help",
  };
}

function interceptTrackingCompleteBeforeLlm(input: LlmAgentTurnInput): LlmAgentTurnResult | null {
  const active = getOrCreateActiveSession(input.callSid);
  const trackingDictationContext = {
    currentState: active.currentState,
    lastSpokenIndex: active.lastSpokenIndex,
  };
  if (!isTrackingDictationCompleteIntent(input.userMessage, trackingDictationContext)) return null;

  const inTrackingFlow =
    Boolean(active.lastSpokenPayload?.trackingForTts) &&
    (active.currentState === "tracking_dictation" || active.cachedIntent === "tracking");

  if (!inTrackingFlow) return null;

  completeTrackingDictation(input.callSid);

  if (isIntentSwitchAwayFromTracking(input.userMessage, input.session ?? undefined)) {
    return null;
  }

  return {
    speech: TRACKING_DICTATION_COMPLETE_SPEECH,
    toolExecutions: [],
    responseType: "general_help",
  };
}

function interceptTrackingDictationLockBeforeLlm(input: LlmAgentTurnInput): LlmAgentTurnResult | null {
  const active = getOrCreateActiveSession(input.callSid);
  const inTracking =
    active.currentState === "tracking_dictation" ||
    (active.currentState === "awaiting_notepad_ready" && active.cachedIntent === "tracking");
  if (!inTracking) return null;

  if (isSpatialResumeQuery(input.userMessage)) return null;
  if (isUserNotepadReadyIntent(input.userMessage, input.callSid)) return null;
  if (isTrackingRequest(input.userMessage)) return null;
  if (
    isTrackingDictationCompleteIntent(input.userMessage, {
      currentState: active.currentState,
      lastSpokenIndex: active.lastSpokenIndex,
      isNotepadReady: active.isNotepadReady,
    })
  ) {
    return null;
  }

  if (isIntentSwitchAwayFromTracking(input.userMessage, input.session ?? undefined)) {
    releaseTrackingFlowForIntentSwitch(input.callSid);
    return null;
  }

  return {
    speech:
      "I'm still on your tracking number. Tell me which digits to repeat from, or let me know once you've written it down.",
    toolExecutions: [],
    responseType: "general_help",
  };
}

function interceptSpatialBeforeLlm(input: LlmAgentTurnInput): LlmAgentTurnResult | null {
  if (!isSpatialResumeQuery(input.userMessage)) return null;

  const active = getOrCreateActiveSession(input.callSid);
  const trackingRaw = String(input.session?.currentOrderData?.tracking_number ?? "").trim();
  if (!active.lastSpokenPayload?.trackingForTts && trackingRaw) {
    ensureTrackingPayload(input.callSid, trackingRaw);
  }

  const refreshed = getOrCreateActiveSession(input.callSid);
  if (!refreshed.spatialIndex.length) return null;

  const turn = resolveSpatialTurnSpeech(
    input.userMessage,
    refreshed.spatialIndex,
    refreshed.lastSpokenPayload?.trackingRaw,
  );
  if (!turn.handled || !turn.speech) return null;

  return {
    speech: turn.speech,
    toolExecutions: [],
    responseType: "general_help",
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

function interceptTrackingBeforeLlm(input: LlmAgentTurnInput): LlmAgentTurnResult | null {
  if (isCatalogShoppingUtterance(input.userMessage)) return null;

  const callerIntent = resolveCallerIntent(input.userMessage, input.session ?? undefined);
  if (callerIntent === "catalog" || callerIntent === "cart") return null;

  const active = getOrCreateActiveSession(input.callSid);
  const trackingGate: TrackingDictationGateContext = { session: input.session };
  if (
    !shouldStartTrackingDictation(
      input.userMessage,
      active.trackingDictationComplete === true,
      trackingGate,
    )
  ) {
    return null;
  }
  const trackingRaw = String(input.session?.currentOrderData?.tracking_number ?? "").trim();
  if (!active.lastSpokenPayload?.trackingForTts && trackingRaw) {
    ensureTrackingPayload(input.callSid, trackingRaw);
  }

  const hasTracking = Boolean(
    getOrCreateActiveSession(input.callSid).lastSpokenPayload?.trackingForTts ||
      hasTrackingInSessionContext(input.session?.currentOrderData),
  );
  if (!hasTracking) return null;

  const gate = resolveDictateTracking(input.callSid);
  return {
    speech: gate.speech,
    toolExecutions: [],
    responseType: gate.intent === "dictate_tracking" ? "order_found" : "general_help",
  };
}

export async function* runLlmAgentTurnEvents(
  input: LlmAgentTurnInput,
): AsyncGenerator<LlmAgentTurnEvent> {
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

  const forcedOrderNumber = detectOrderNumberForForcedLookup(input);
  if (forcedOrderNumber) {
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

  const spatialIntercept = interceptSpatialBeforeLlm(input);
  if (spatialIntercept) {
    yield { type: "result", result: spatialIntercept };
    return;
  }

  const trackingDictationLock = interceptTrackingDictationLockBeforeLlm(input);
  if (trackingDictationLock) {
    yield { type: "result", result: trackingDictationLock };
    return;
  }

  const notepadReadyIntercept = interceptNotepadReadyBeforeLlm(input);
  if (notepadReadyIntercept) {
    yield { type: "result", result: notepadReadyIntercept };
    return;
  }

  const trackingCompleteIntercept = interceptTrackingCompleteBeforeLlm(input);
  if (trackingCompleteIntercept) {
    yield { type: "result", result: trackingCompleteIntercept };
    return;
  }

  const trackingIntercept = interceptTrackingBeforeLlm(input);
  if (trackingIntercept) {
    yield { type: "result", result: trackingIntercept };
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
              (candidate.function.name === "add_to_cart" ||
                candidate.function.name === "remove_from_cart" ||
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
            })
          ) {
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
              content: JSON.stringify({
                status: "CACHED",
                source: "ActiveSession",
                instructions:
                  "Do NOT re-fetch. Use lastSpokenPayload from SOVEREIGN ACTIVE SESSION. Obey SILENCE PROTOCOL unless caller said 'full summary'.",
                lastSpoken: active.lastSpokenPayload,
              }),
            });
            continue;
          }

          const record = await ServiceRegistry.executeTool(
            call.function.name,
            parsedArgs,
            input.callSid,
            input.session,
          );
          toolExecutions.push(record);

          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: toolResultForLlm(record, {
              isVerifiedCaller: input.session?.isVerifiedCaller === true,
              session: input.session,
            }),
          });
        }

        const lastCatalogExec = [...toolExecutions].reverse().find(
          (exec) =>
            exec.tool === "search_shopify_book_by_title" ||
            exec.tool === "search_shopify_book_by_isbn" ||
            exec.tool === "add_to_cart" ||
            exec.tool === "send_checkout_email",
        );
        const lastOrderExec = [...toolExecutions]
          .reverse()
          .find((exec) => exec.tool === "get_shopify_order_status");
        // Catalog/buy tools win when the caller pivoted away from order status.
        if (lastOrderExec && !lastCatalogExec) {
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
