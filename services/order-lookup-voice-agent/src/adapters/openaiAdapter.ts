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
import { ServiceRegistry } from "../sovereign/serviceRegistry.js";
import { groundedOrderSpeech } from "../agents/fulfillmentHandlers.js";
import { LLM_ORCHESTRATOR_TEMPERATURE } from "../agents/llmConfig.js";
import { extractOrderNumberFromStt } from "../nlp/entityExtractor.js";
import {
  ORDER_NOT_FOUND_STRICT_SPOKEN,
  SYSTEM_MAINTENANCE_SPOKEN,
} from "../constants/systemMessages.js";
import { dispatchAgentEvent, getAgentState } from "../platform/eventDispatcher.js";
import { extractOrderNumberFromSpeech, orderNumbersMatch } from "../utils/formatter.js";
import { buildPolitePivotSpeech, isOutOfDomainQuestion } from "../utils/domainGuard.js";
import { buildActiveOrderContextSystemMessage, redactTrackingFromOrderContext } from "../agents/sessionManager.js";
import { filterOrderContextForVerification } from "../agents/orderContextPrivacy.js";
import type { ActiveOrderContextData } from "../agents/sessionManager.js";
import { buildCartContextSystemMessage } from "../agents/cartManager.js";
import { buildVaultSecuritySystemMessage } from "../agents/callerVerification.js";
import type { CallSession } from "../types/order.js";
import {
  buildRefundEmailFollowUpSpeech,
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
import {
  buildClarifyingResponse,
  buildGreetingResponse,
  buildOrderNumberOfferResponse,
  isOrderNumberOfferUtterance,
  isSocialGreetingUtterance,
} from "../handlers/greetingHandler.js";
import { stripRoboticAssistantSpeech, softFallback } from "../agents/conversationBrainAgent.js";
import { buildLockedFlowSystemMessage } from "../agents/lockedFlowState.js";
import {
  buildActiveSessionSystemMessage,
  getOrCreateActiveSession,
  ensureTrackingPayload,
  shouldSkipToolReinvoke,
} from "../sovereign/activeSession.js";
import { NOTEPAD_HANDSHAKE_PROMPT } from "../sovereign/sovereignRouter.js";
import { isTrackingRequest, hasTrackingInSessionContext, isTrackingDictationCompleteIntent } from "../agents/trackingIntent.js";
import { resolveDictateTracking } from "../sovereign/dictateTrackingGate.js";
import { isSpatialResumeQuery, resolveSpatialTurnSpeech } from "../sovereign/spatialDictation.js";
import { promptUserForNotepad, completeTrackingDictation, TRACKING_DICTATION_COMPLETE_SPEECH } from "../agents/dictationTool.js";
import { isTrackingDictationText } from "../utils/ttsFormatter.js";

export const SHOPIFY_LLM_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_shopify_order_status",
      description:
        "Fetch real order details from Shopify. Pass ONLY the digit sequence the caller stated — strip filler words and hesitation. Translate non-English order references to English digits before calling.",
      parameters: {
        type: "object",
        properties: {
          orderNumber: {
            type: "string",
            description:
              "Order digits only (e.g. 21698 or 21698-F1). Extract from rambling speech — never pass 'uhh', 'please', or full sentences. Translate non-English number words to digits first. Never guess.",
          },
        },
        required: ["orderNumber"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_customer_history",
      description:
        "Fetch the caller's compressed recent order history (up to 15 orders: orderNumber, monthYear, totalAmount, status, items). ONLY for verified callers after a successful order lookup. Use VIP ORDER HISTORY DRILL-DOWN S.O.P. when speaking results.",
      parameters: {
        type: "object",
        properties: {
          customerId: {
            type: "string",
            description:
              "Shopify Customer GID from the current order context (gid://shopify/Customer/...). Optional when already on session.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_shopify_book_by_isbn",
      description:
        "Search the SureShot Books catalog by ISBN. Pass ONLY digit characters — strip filler and phonetic noise from spoken ISBN.",
      parameters: {
        type: "object",
        properties: {
          isbn: {
            type: "string",
            description:
              "ISBN digits only (10 or 13). Extract from spoken input — ignore 'uhh', 'the number is', and phonetic letter qualifiers. Never pass conversational filler.",
          },
        },
        required: ["isbn"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_shopify_book_by_title",
      description:
        "Search the SureShot Books catalog by book title. Returns up to 5 similar volume/variant matches. Never pass conversational filler — extract ONLY core title keywords (e.g. 'Harry Potter' not 'uhh I want a book called Harry Potter please'). Translate non-English titles to English before calling.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "Core book title keywords only — no filler, punctuation, or full sentences. Example: caller says 'Uhh I am looking for a book called Harry Potter please' → pass 'Harry Potter'.",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dictate_tracking",
      description:
        "Read the tracking number aloud with slow phonetic pacing. ONLY call after the caller confirms pen and notepad are ready (isNotepadReady). If not ready, the tool returns ReadinessRequest.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_to_cart",
      description:
        "Add one or more books to the caller's persistent shopping cart. Always pass unit_price from search results alongside variant_id when available.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                variant_id: { type: "string" },
                product_id: { type: "string" },
                isbn: { type: "string" },
                unit_price: { type: "string", description: "Per-unit catalog price from search (e.g. 12.99)" },
                quantity: { type: "number" },
              },
              required: ["title", "unit_price"],
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_from_cart",
      description: "Remove items or reduce quantities in the caller's shopping cart.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                variant_id: { type: "string" },
                quantity: { type: "number" },
              },
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_cart_summary",
      description: "Return the caller's current shopping cart contents.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_checkout_email",
      description:
        "After email verification, create a Shopify draft order and email the secure checkout link to the customer.",
      parameters: {
        type: "object",
        properties: {
          customerEmail: {
            type: "string",
            description: "Verified customer email — any valid domain.",
          },
          customerName: { type: "string", description: "Customer full name." },
        },
        required: ["customerEmail", "customerName"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_support_escalation",
      description:
        "Email jessica@sureshotbooks.com after letter-by-letter email verification when a book cannot be found, is out of stock, an unverified caller needs account help, or the issue cannot be resolved on the call.",
      parameters: {
        type: "object",
        properties: {
          customerName: { type: "string" },
          customerEmail: { type: "string" },
          issueSummary: {
            type: "string",
            description: "Concise summary of the unresolved issue for support.",
          },
        },
        required: ["issueSummary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "end_call",
      description:
        "Invoke ONLY when the caller is explicitly done: goodbye, thank you, okay bye, or 'no' after you asked if they need anything else. NEVER use during cart modifications, quantity changes, or partial-title shopping. Say the SureShot goodbye line first, then call this tool.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

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
  const last = executions[executions.length - 1];
  if (!last?.data) return {};

  if (
    last.tool === "get_shopify_order_status" &&
    "status" in last.data &&
    last.data.status === "found" &&
    "orderNumber" in last.data
  ) {
    return { recordOrderNumber: last.data.orderNumber };
  }

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

  if (input.activeOrderContext && Object.keys(input.activeOrderContext).length > 0) {
    const active = getOrCreateActiveSession(input.callSid);
    const verified = input.session?.isVerifiedCaller === true;
    const orderContext = filterOrderContextForVerification(
      redactTrackingFromOrderContext(input.activeOrderContext, active.isNotepadReady),
      verified,
    );
    systemMessages.push({
      role: "system",
      content: buildActiveOrderContextSystemMessage(orderContext),
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

function detectOrderNumberForForcedLookup(input: LlmAgentTurnInput): string | null {
  const awaitingSlot = isAwaitingOrderNumberSlot(input);
  const bareOrder = isBareOrderNumberUtterance(input.userMessage);
  const allowLoose = awaitingSlot || bareOrder;

  const orderNumber =
    extractOrderNumberFromStt(input.userMessage, { awaitingSlot: allowLoose }) ??
    (allowLoose ? extractOrderNumberFromSpeech(input.userMessage) : null);

  if (!orderNumber) return null;

  const agentState = getAgentState(input.callSid);
  const orderAlreadyFound =
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
    /\b(order|track|status|number|lookup)\b/i.test(lower);

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

function groundedSpeechFromOrderToolRecord(record: LlmToolExecutionRecord): string {
  if (record.status === "blocked") {
    return record.errorMessage ?? "What's your order number?";
  }
  if (
    record.status === "system_maintenance" ||
    record.status === "api_error" ||
    record.status === "throttled"
  ) {
    return SYSTEM_MAINTENANCE_SPOKEN;
  }
  if (record.data && "orderNumber" in record.data) {
    return groundedOrderSpeech(record.data);
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
): LlmAgentTurnResult {
  const speech = groundedSpeechFromOrderToolRecord(record);
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

  return {
    speech: TRACKING_DICTATION_COMPLETE_SPEECH,
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
  if (active.isNotepadReady) return speech;
  if (!active.lastSpokenPayload?.trackingForTts) return speech;
  if (isTrackingDictationText(speech)) {
    return promptUserForNotepad();
  }
  return speech;
}

function interceptTrackingBeforeLlm(input: LlmAgentTurnInput): LlmAgentTurnResult | null {
  if (!isTrackingRequest(input.userMessage)) return null;

  const active = getOrCreateActiveSession(input.callSid);
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
    if (input.session) {
      input.session.awaitingInput = null;
    }
    yield { type: "tool_pending", tools: ["get_shopify_order_status"] };
    const record = await ServiceRegistry.executeTool(
      "get_shopify_order_status",
      { orderNumber: forcedOrderNumber },
      input.callSid,
    );
    yield {
      type: "result",
      result: resultFromOrderToolExecution(record, [record]),
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

  const spatialIntercept = interceptSpatialBeforeLlm(input);
  if (spatialIntercept) {
    yield { type: "result", result: spatialIntercept };
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

  if (isClosingConversationUtterance(input.userMessage, input.messages)) {
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
      const response = await getClient().chat.completions.create({
        model: getConfig().CONVERSATION_BRAIN_MODEL,
        temperature: LLM_ORCHESTRATOR_TEMPERATURE,
        max_tokens: 450,
        tools: resolveToolsForTurn(input),
        tool_choice: "auto",
        messages,
      });

      const choice = response.choices[0];
      const message = choice?.message;
      if (!message) break;

      const toolCalls = message.tool_calls ?? [];
      const finishReason = choice.finish_reason;

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
            content: message.content ?? "",
            tool_calls: toolCalls,
          },
        ];

        for (const call of toolCalls) {
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
          if (
            intentKey &&
            shouldSkipToolReinvoke(active, intentKey, call.function.name)
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
            }),
          });
        }

        const lastOrderExec = [...toolExecutions]
          .reverse()
          .find((exec) => exec.tool === "get_shopify_order_status");
        if (lastOrderExec) {
          yield {
            type: "result",
            result: resultFromOrderToolExecution(lastOrderExec, toolExecutions),
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
              speech: (message.content ?? "").trim() || SURESHOT_GOODBYE_SPEECH,
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

      let speech = (message.content ?? "").trim();
      if (speech) {
        speech = stripRoboticAssistantSpeech(speech, input.userMessage);
        speech = enforceNotepadGateOnSpeech(input.callSid, speech);
        speech = await ensureUniqueSpokenResponse(input.callSid, speech, input.userMessage);
        const responseType = inferResponseType(speech, toolExecutions);
        const endCall = toolExecutions.some((t) => t.tool === "end_call" && t.ok);
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
