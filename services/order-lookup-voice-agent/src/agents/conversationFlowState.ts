/**
 * Strict conversation flow state machine — PURCHASE_FLOW vs SUPPORT_FLOW.
 *
 * PURCHASE_FLOW: product search, similarity matching, cart additions only.
 * SUPPORT_FLOW: existing order lookups and order follow-ups only.
 */
export type ConversationFlowMode = "idle" | "PURCHASE_FLOW" | "SUPPORT_FLOW";

const PURCHASE_INTENTS = new Set([
  "product_search",
  "isbn_query",
  "catalog",
  "cart",
  "product_purchase_intent",
  "title_search",
  "isbn_search",
]);

const SUPPORT_INTENTS = new Set([
  "order_lookup",
  "order_status",
  "order_field_query",
  "order_history",
  "repeat_order",
  "tracking_dictation",
  "tracking_flow_active",
  "refund",
]);

const CONFIRM_KEYWORD_RE =
  /^\s*(yes|yeah|yep|yup|confirm|confirmed|ok(?:ay)?|go\s+ahead|that's\s+(?:fine|correct|right)|sounds\s+good)\s*[.!?]?\s*$/i;

const flowByCall = new Map<string, ConversationFlowMode>();

export function getConversationFlowMode(callSid: string): ConversationFlowMode {
  return flowByCall.get(callSid) ?? "idle";
}

export function setConversationFlowMode(
  callSid: string,
  mode: ConversationFlowMode,
): ConversationFlowMode {
  flowByCall.set(callSid, mode);
  return mode;
}

export function clearConversationFlowMode(callSid: string): void {
  flowByCall.delete(callSid);
}

export function clearAllConversationFlowModes(): void {
  flowByCall.clear();
}

export function isConfirmKeyword(text: string): boolean {
  return CONFIRM_KEYWORD_RE.test((text ?? "").trim());
}

/** Map classifier / router intent labels into a flow mode when unambiguous. */
export function flowModeForIntent(intent: string): ConversationFlowMode | null {
  const key = (intent ?? "").trim().toLowerCase();
  if (!key) return null;
  if (PURCHASE_INTENTS.has(key)) return "PURCHASE_FLOW";
  if (SUPPORT_INTENTS.has(key)) return "SUPPORT_FLOW";
  return null;
}

export function transitionFlowForIntent(callSid: string, intent: string): ConversationFlowMode {
  const next = flowModeForIntent(intent);
  if (!next) return getConversationFlowMode(callSid);
  return setConversationFlowMode(callSid, next);
}

export function isPurchaseFlowActive(callSid: string): boolean {
  return getConversationFlowMode(callSid) === "PURCHASE_FLOW";
}

export function isSupportFlowActive(callSid: string): boolean {
  return getConversationFlowMode(callSid) === "SUPPORT_FLOW";
}

/** PURCHASE_FLOW blocks order/support tool routing; SUPPORT_FLOW blocks catalog/cart tools. */
export function isIntentAllowedInCurrentFlow(callSid: string, intent: string): boolean {
  const mode = getConversationFlowMode(callSid);
  if (mode === "idle") return true;

  const target = flowModeForIntent(intent);
  if (!target) return true;

  if (mode === "PURCHASE_FLOW") {
    return target === "PURCHASE_FLOW";
  }
  if (mode === "SUPPORT_FLOW") {
    return target === "SUPPORT_FLOW";
  }
  return true;
}

/**
 * Confirm keywords in PURCHASE_FLOW must not cross-reference SUPPORT order context.
 * Returns true when the utterance should stay in purchase tooling only.
 */
export function shouldBlockSupportCrossReference(callSid: string, text: string): boolean {
  return isPurchaseFlowActive(callSid) && isConfirmKeyword(text);
}
