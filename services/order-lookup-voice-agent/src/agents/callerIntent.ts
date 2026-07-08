/**
 * Intent-first router — classifies caller utterances before phase gates or tools.
 */
import type { CallSession } from "../types/order.js";
import { isExplicitGoodbyeUtterance } from "../services/llmService.js";
import { extractIsbnFromSpeech } from "../utils/productSearchNormalize.js";
import { getOrCreateActiveSession } from "../sovereign/activeSession.js";
import { isSpatialResumeQuery } from "../sovereign/spatialDictation.js";
import {
  isExplicitTrackingDictationRequest,
  isTrackingDictationCompleteIntent,
} from "./trackingIntent.js";
import { isUserNotepadReadyIntent } from "./dictationTool.js";
import { isRefundNotificationEmailQuestion } from "./orderFollowUpSpeech.js";

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
  | "repeat_order"
  | "general_help";

const ORDER_FIELD_QUERY_RE =
  /\b(customer\s+name|name\s+on\s+(?:the\s+)?order|who\s+is\s+this\s+order\s+for|who\s+ordered|what\s+is\s+the\s+name|refund\s+reason|cancel\s+reason|why\s+(?:was|is)\s+(?:it|my\s+order)\s+(?:refunded|cancelled)|how\s+many\s+books|item\s+count|total\s+amount|shipping\s+(?:cost|fee)|payment\s+method|card\s+ending|what\s+email|order\s+status|where\s+is\s+my\s+order|status\s+of\s+my\s+order)\b/i;

const ORDER_HISTORY_RE =
  /\b(order\s+history|past\s+orders|previous\s+orders|my\s+other\s+orders|orders\s+in\s+\w+)\b/i;

const ORDER_LOOKUP_RE =
  /\b(order\s+number|lookup\s+(?:my\s+)?order|find\s+(?:my\s+)?order|track\s+my\s+order|check\s+(?:an?\s+)?order)\b/i;

const CATALOG_RE =
  /\b(book|books|isbn|title|magazine|looking\s+for\s+a\s+book|buy\s+a\s+book|add\s+to\s+cart)\b/i;

const CART_RE = /\b(cart|checkout|invoice|pay\s+for)\b/i;

const REPEAT_ORDER_RE =
  /\b(repeat|say\s+that\s+again|order\s+details|what\s+did\s+you\s+find|summary)\b/i;

function hasActiveOrderContext(session?: CallSession): boolean {
  return Boolean(
    session?.currentOrderData && Object.keys(session.currentOrderData).length > 0,
  );
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

/** Classify caller intent before phase gates — tracking only when explicit or mid-flow. */
export function resolveCallerIntent(
  callerText: string,
  session?: CallSession,
): CallerIntent {
  const text = callerText.trim();
  if (!text) return "neutral_listen";

  const callSid = session?.callSid ?? "";
  const active = callSid ? getOrCreateActiveSession(callSid) : undefined;

  if (callSid && active) {
    if (
      active.currentState === "awaiting_notepad_ready" &&
      active.cachedIntent === "tracking"
    ) {
      if (ORDER_FIELD_QUERY_RE.test(text) || isRefundNotificationEmailQuestion(text)) {
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
      // State exit — unrelated query while notepad handshake is pending.
    }
  }

  if (isExplicitGoodbyeUtterance(text)) return "goodbye";

  if (isRefundNotificationEmailQuestion(text) && hasActiveOrderContext(session)) {
    return "order_field_query";
  }

  if (ORDER_FIELD_QUERY_RE.test(text) && hasActiveOrderContext(session)) {
    return "order_field_query";
  }

  if (ORDER_HISTORY_RE.test(text) && hasActiveOrderContext(session)) {
    return "order_history";
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

  if (CART_RE.test(text)) return "cart";

  if (extractIsbnFromSpeech(text) || CATALOG_RE.test(text)) return "catalog";

  if (isExplicitTrackingDictationRequest(text)) {
    return "tracking_dictation";
  }

  if (!hasActiveOrderContext(session) && /\border\b/i.test(text)) {
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

export function shouldRunTrackingPhaseGate(intent: CallerIntent): boolean {
  return intent === "tracking_dictation" || intent === "tracking_flow_active";
}

/** True when an unrelated turn should tear down an in-progress notepad handshake. */
export function shouldExitTrackingHandshake(intent: CallerIntent): boolean {
  return !shouldRunTrackingPhaseGate(intent);
}
