/**
 * Intent-first router — classifies caller utterances before phase gates or tools.
 */
import type { CallSession } from "../types/order.js";
import { isExplicitGoodbyeUtterance } from "../services/llmService.js";
import { extractIsbnFromSpeech } from "../utils/productSearchNormalize.js";
import { getOrCreateActiveSession, updateActiveSession } from "../sovereign/activeSession.js";
import { isSpatialResumeQuery } from "../sovereign/spatialDictation.js";
import {
  isExplicitTrackingDictationRequest,
  isTrackingDictationCompleteIntent,
  isOrderTrackingIdShorthand,
} from "./trackingIntent.js";
import { isUserNotepadReadyIntent, isTrackingDictationPending } from "./dictationTool.js";
import { isRefundNotificationEmailQuestion, isOrderFieldQuestion } from "./orderFollowUpSpeech.js";
import { extractTitleFromStt } from "../nlp/entityExtractor.js";
import { isCatalogShoppingUtterance } from "./catalogShoppingIntent.js";
import {
  hasConfirmedOrderContext,
  isOrderLookupRequestWithoutNumber,
} from "./orderContextPolicy.js";
import {
  shouldBlockSupportCrossReference,
  transitionFlowForIntent,
} from "./conversationFlowState.js";

export type CallerIntent =
  | "goodbye"
  | "neutral_listen"
  | "order_lookup"
  | "order_field_query"
  | "order_history"
  | "tracking_dictation"
  | "tracking_flow_active"
  | "catalog"
  | "cart"
  | "support_escalation"
  | "repeat_order"
  | "general_help";

const ORDER_FIELD_QUERY_RE =
  /\b(customer\s+name|name\s+on\s+(?:the\s+)?order|who\s+is\s+this\s+order\s+for|who\s+ordered|what\s+is\s+the\s+name|refund\s+reason|cancel\s+reason|why\s+(?:was|is)\s+(?:it|my\s+order)\s+(?:refunded|cancelled)|how\s+many\s+(?:books|items|products)|item\s+count|quantity|total\s+product|total\s+products|total\s+items|total\s+order\s+number|number\s+of\s+(?:books|items|products)|product\s+title|item\s+title|book\s+title|product\s+titles|what\s+is\s+the\s+title|what'?s\s+the\s+title|product\s+amount|item\s+amount|book\s+price|(?:their|the|each)\s+price|prices?|how\s+much|total\s+amount|order\s+total|what\s+is\s+the\s+total|shipping\s+(?:cost|fee|fees|amount)|payment\s+method|card\s+ending|what\s+email|order\s+status|where\s+is\s+my\s+order|status\s+of\s+my\s+order|order\s+details|product\s+detail|item\s+detail|tell\s+me\s+(?:the\s+)?details|tell\s+me\s+about\s+(?:the\s+)?(?:product|order|items|books)|what\s+did\s+(?:i|you)\s+order|which\s+books?)\b/i;

const ORDER_HISTORY_RE =
  /\b(order\s+history|past\s+orders|previous\s+orders|my\s+other\s+orders|orders\s+in\s+\w+)\b/i;

const ORDER_LOOKUP_RE =
  /\b(order\s+number|lookup\s+(?:my\s+)?order|find\s+(?:my\s+)?order|track\s+my\s+order|check\s+(?:an?\s+)?order)\b/i;

const CATALOG_RE =
  /\b(book|books|isbn|magazine|good\s+books?|looking\s+for\s+(?:a\s+)?(?:book|product)|buy\s+(?:a\s+)?(?:book|product|books)|purchase\s+(?:a\s+)?(?:book|product)|how\s+(?:can|do)\s+i\s+buy|want\s+to\s+buy|i\s+want\s+(?:a\s+)?product|add\s+to\s+cart|recommend\s+(?:a\s+)?book|search\s+for\s+(?:a\s+)?book|book\s+(?:called|titled|named)|title\s+is|find\s+(?:me\s+)?(?:a\s+)?book)\b/i;

const CART_RE = /\b(cart|checkout|invoice|pay\s+for|payment\s+link)\b/i;

const SUPPORT_ESCALATION_RE =
  /\b(talk\s+to\s+(?:a\s+)?(?:human|person|agent|representative|support|supporter)|speak\s+to\s+(?:a\s+)?(?:human|person|agent|representative|support|supporter)|customer\s+support|support\s+team|supporter\s+team|escalat(?:e|ion)|forward\s+(?:this|my)\s+(?:message|request)|call\s+me\s+back|need\s+(?:a\s+)?human|real\s+person|live\s+agent)\b/i;

export function isSupportEscalationRequest(text: string): boolean {
  return SUPPORT_ESCALATION_RE.test(text.trim());
}

const REPEAT_ORDER_RE =
  /\b(repeat|say\s+that\s+again|order\s+details|what\s+did\s+you\s+find|summary)\b/i;

function hasActiveOrderContext(session?: CallSession): boolean {
  return hasConfirmedOrderContext(session);
}

function isInActiveTrackingFlow(callSid: string): boolean {
  const active = getOrCreateActiveSession(callSid);
  if (active.currentState === "tracking_dictation") return true;
  if (
    active.currentState === "awaiting_notepad_ready" &&
    active.cachedIntent === "tracking" &&
    Boolean(active.lastSpokenPayload?.trackingForTts)
  ) {
    return true;
  }
  return false;
}

/** True when caller pivots away from tracking — catalog, order info, cart, or support. */
export function isIntentSwitchAwayFromTracking(
  text: string,
  session?: CallSession,
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (isSupportEscalationRequest(trimmed)) return true;
  if (CART_RE.test(trimmed)) return true;
  if (isCatalogShoppingUtterance(trimmed)) return true;
  if (extractIsbnFromSpeech(trimmed) || CATALOG_RE.test(trimmed)) return true;
  if (hasActiveOrderContext(session)) {
    if (isOrderFieldQuestion(trimmed, session)) {
      return true;
    }
    if (ORDER_HISTORY_RE.test(trimmed)) return true;
  }
  if (ORDER_LOOKUP_RE.test(trimmed)) return true;
  return false;
}

/** Classify caller intent before phase gates — tracking only when explicit or mid-flow. */
function resolveCallerIntentCore(
  callerText: string,
  session?: CallSession,
): CallerIntent {
  const text = callerText.trim();
  if (!text) return "neutral_listen";

  const callSid = session?.callSid ?? "";
  const active = callSid ? getOrCreateActiveSession(callSid) : undefined;

  if (callSid && shouldBlockSupportCrossReference(callSid, text)) {
    return "catalog";
  }

  if (
    callSid &&
    active &&
    isUserNotepadReadyIntent(text) &&
    isTrackingDictationPending(callSid, session?.currentOrderData)
  ) {
    return "tracking_flow_active";
  }

  if (callSid && active) {
    const inTrackingHandshake =
      (active.currentState === "awaiting_notepad_ready" ||
        active.currentState === "tracking_dictation") &&
      active.cachedIntent === "tracking";

    if (inTrackingHandshake) {
      if (isSupportEscalationRequest(text)) return "support_escalation";
      if (isOrderFieldQuestion(text, session)) {
        return "order_field_query";
      }
      if (ORDER_HISTORY_RE.test(text) && hasActiveOrderContext(session)) {
        return "order_history";
      }
      if (CART_RE.test(text)) return "cart";
      if (extractIsbnFromSpeech(text) || CATALOG_RE.test(text)) return "catalog";
      if (
        isUserNotepadReadyIntent(text) ||
        isExplicitTrackingDictationRequest(text) ||
        /\b(?:ready|notepad|pen\s+and)\b/i.test(text)
      ) {
        return "tracking_flow_active";
      }
      // State exit — unrelated query while tracking flow is active.
    }
  }

  if (isExplicitGoodbyeUtterance(text)) return "goodbye";

  if (isSupportEscalationRequest(text)) return "support_escalation";

  if (isCatalogShoppingUtterance(text)) return "catalog";

  if (CART_RE.test(text)) return "cart";

  // Active-order follow-ups beat catalog title sniffing ("what is the title on my order").
  if (hasActiveOrderContext(session)) {
    if (isOrderFieldQuestion(text, session)) return "order_field_query";
    if (ORDER_HISTORY_RE.test(text)) return "order_history";
  }

  if (isOrderLookupRequestWithoutNumber(text)) return "order_lookup";

  if (extractIsbnFromSpeech(text) || CATALOG_RE.test(text)) {
    return "catalog";
  }
  // Named-title searches only — never treat "customer name" / multi-word questions as titles.
  const spokenTitle = extractTitleFromStt(text);
  if (
    spokenTitle &&
    /\b(book|books|isbn|title|looking\s+for|search|buy|purchase|find\s+(?:me\s+)?(?:a\s+)?book)\b/i.test(
      text,
    )
  ) {
    return "catalog";
  }

  if (ORDER_LOOKUP_RE.test(text)) {
    return "order_lookup";
  }

  if (
    callSid &&
    isInActiveTrackingFlow(callSid) &&
    (isSpatialResumeQuery(text) ||
      isTrackingDictationCompleteIntent(text, {
        currentState: active?.currentState,
        lastSpokenIndex: active?.lastSpokenIndex,
        isNotepadReady: active?.isNotepadReady,
      }) ||
      isExplicitTrackingDictationRequest(text) ||
      /\b(?:ready|notepad|pen\s+and)\b/i.test(text))
  ) {
    return "tracking_flow_active";
  }

  if (REPEAT_ORDER_RE.test(text) && session?.currentOrder) {
    if (isSpatialResumeQuery(text)) return "tracking_flow_active";
    if (/\b(tracking|tracking\s+id|tracking\s+number|digit)\b/i.test(text)) {
      return "tracking_flow_active";
    }
    if (/\brepeat\b/i.test(text) && /\b(after|before|from)\b/i.test(text)) {
      return "tracking_flow_active";
    }
    return "repeat_order";
  }

  if (isExplicitTrackingDictationRequest(text)) {
    return "tracking_dictation";
  }

  const cartActive = (session?.shoppingCart?.length ?? 0) > 0;
  const orderTrackingOnFile = Boolean(
    String(session?.currentOrderData?.tracking_number ?? "").trim(),
  );
  if (!cartActive && orderTrackingOnFile && isOrderTrackingIdShorthand(text)) {
    return "tracking_dictation";
  }

  // "I want to order a book" is catalog, not order lookup.
  if (
    !hasActiveOrderContext(session) &&
    /\border\b/i.test(text) &&
    !/\b(book|books|isbn|title|product|magazine)\b/i.test(text)
  ) {
    return "order_lookup";
  }

  if (
    /^(hi|hello|hey|howdy|good\s+(morning|afternoon|evening))[\s!.?,]*$/i.test(text) ||
    /\b(how\s+are\s+you|how'?s\s+it\s+going)\b/i.test(text)
  ) {
    return "neutral_listen";
  }

  return "general_help";
}

export function resolveCallerIntent(
  callerText: string,
  session?: CallSession,
): CallerIntent {
  const intent = resolveCallerIntentCore(callerText, session);
  const callSid = session?.callSid ?? "";
  if (callSid) transitionFlowForIntent(callSid, intent);
  return intent;
}

export function shouldRunTrackingPhaseGate(intent: CallerIntent): boolean {
  return intent === "tracking_dictation" || intent === "tracking_flow_active";
}

/** Tear down in-progress tracking handshake when caller pivots to another intent. */
export function releaseTrackingFlowForIntentSwitch(
  callSid: string,
  options?: { pivotToCatalog?: boolean },
): void {
  const active = getOrCreateActiveSession(callSid);
  const trackingActive =
    active.currentState === "awaiting_notepad_ready" ||
    active.currentState === "tracking_dictation" ||
    active.cachedIntent === "tracking" ||
    active.lastSpokenPayload?.kind === "tracking";

  if (!trackingActive && !options?.pivotToCatalog) return;

  if (options?.pivotToCatalog) {
    updateActiveSession(callSid, {
      currentState: "catalog_active",
      cachedIntent: "catalog",
      awaitingClarification: null,
      isNotepadReady: false,
      spatialIndex: [],
      lastSpokenIndex: -1,
      ...(active.lastSpokenPayload?.kind === "tracking" ? { lastSpokenPayload: null } : {}),
    });
    return;
  }

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

/** True when an unrelated turn should tear down an in-progress notepad handshake. */
export function shouldExitTrackingHandshake(intent: CallerIntent): boolean {
  if (intent === "support_escalation") return true;
  if (intent === "catalog" || intent === "cart") return true;
  if (intent === "order_field_query" || intent === "order_history") return true;
  if (intent === "order_lookup") return true;
  return !shouldRunTrackingPhaseGate(intent);
}
