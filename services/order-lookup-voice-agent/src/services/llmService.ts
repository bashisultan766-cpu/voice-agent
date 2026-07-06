/**
 * Lightweight LLM helpers for follow-up classification and background analysis.
 */
import OpenAI from "openai";
import { getConfig } from "../config.js";
import type { StructuredOrder } from "../types/order.js";
import type { CallSession } from "../types/order.js";
import {
  isLockedFlowState,
  isPaymentLinkActionUtterance,
} from "../agents/lockedFlowState.js";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: getConfig().OPENAI_API_KEY });
  }
  return client;
}

/** Explicit farewell only — bare "no" or "thank you" must NOT end the call unless closing the conversation. */
export function isExplicitGoodbyeUtterance(callerText: string): boolean {
  const text = callerText.toLowerCase().trim();
  if (!text) return false;
  return /\b(goodbye|good bye|bye|see you|see ya|hang up|hangup|end call|end the call|finished|i'?m finished|we'?re done|all done|that'?s all|that is all|nothing else|i'?m done|im done)\b/i.test(
    text,
  );
}

/** Rapid cart quantity/title changes — must not trigger hangup. */
const NO_CART_CORRECTION_KEYWORDS =
  /\b(make it|wait|change|actually|add|minus|remove|delete|copies?|quantity|instead|scratch that|more of|less of|\d+)\b/i;

/** "No" followed by cart math — correction, not goodbye (e.g. "No, make it 10 copies"). */
export function isNoWithCartCorrection(callerText: string): boolean {
  const text = callerText.toLowerCase().trim();
  if (!/\bno\b/.test(text)) return false;
  return NO_CART_CORRECTION_KEYWORDS.test(text);
}

export function isCartModificationUtterance(callerText: string): boolean {
  const text = callerText.toLowerCase().trim();
  if (!text) return false;

  const cartVerb =
    /\b(add|remove|delete|subtract|minus|take off|take out|take away|drop|reduce|increase|change|make it|update|put in|copies?|quantity|more of|less of|in my cart|from (the )?cart)\b/i.test(
      text,
    );
  const mindChange =
    /\b(no,? (make it|wait|change|actually)|instead|scratch that|never\s*mind)\b/i.test(text);
  const quantityWithAction = /\b\d+\b/.test(text) && cartVerb;

  return cartVerb || mindChange || quantityWithAction;
}


/** Caller explicitly wants to end the call — the only cases where end_call may proceed. */
export function isExplicitEndCallIntent(
  callerText: string,
  messages: Array<{ role: string; content: string }> = [],
): boolean {
  if (isCartModificationUtterance(callerText)) return false;

  if (isClosingConversationUtterance(callerText, messages)) return true;

  const text = callerText.toLowerCase().trim();
  if (/^no,? thank(s| you)\b/i.test(text)) return true;
  if (
    /\b(i don'?t need anything else|don'?t need anything else|nothing else|that'?s all i need)\b/i.test(
      text,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Global anti-hangup guard — block end_call unless the caller explicitly closes the
 * conversation (goodbye, no thank you, or declining further help after "anything else?").
 */
export function shouldBlockPrematureEndCall(input: {
  userMessage: string;
  messages?: Array<{ role: string; content: string }>;
  toolExecutions?: Array<{ tool: string }>;
  session?: CallSession;
}): boolean {
  if (isCartModificationUtterance(input.userMessage)) return true;
  if (isPaymentLinkActionUtterance(input.userMessage)) return true;

  const explicitClose = isExplicitEndCallIntent(input.userMessage, input.messages ?? []);
  if (input.session && isLockedFlowState(input.session) && !explicitClose) return true;

  return !explicitClose;
}

/** True when end_call may appear in the LLM tool list for this turn. */
export function shouldOfferEndCallTool(input: {
  userMessage: string;
  messages?: Array<{ role: string; content: string }>;
}): boolean {
  return isExplicitEndCallIntent(input.userMessage, input.messages ?? []);
}

/** Thank-you / closing turns that should trigger graceful hangup. */
export function isClosingConversationUtterance(
  callerText: string,
  messages: Array<{ role: string; content: string }> = [],
): boolean {
  if (isCartModificationUtterance(callerText)) return false;
  if (isNoWithCartCorrection(callerText)) return false;

  if (isExplicitGoodbyeUtterance(callerText)) return true;

  const text = callerText.toLowerCase().trim();
  if (/^(okay bye|ok bye|okay, bye|ok, bye)\b/.test(text)) {
    return true;
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (lastAssistant && /anything else/i.test(lastAssistant.content)) {
    if (isNoWithCartCorrection(text)) return false;
    if (/\b(copies?|make it|add|minus|remove|\d+)\b/.test(text)) return false;
    if (/^(no|nope|nothing|that'?s all|that is all|that'?s it|i'?m good|all set)\b/.test(text)) {
      return true;
    }
  }

  return false;
}

export function orderSummaryLooksComplete(
  script: string,
  order: StructuredOrder,
): boolean {
  const lower = script.toLowerCase();
  const name = order.customerName.toLowerCase();
  const orderDigits = order.orderNumber.replace(/\D/g, "");
  const hasName = lower.includes(name.split(" ")[0] ?? name);
  const hasCount = lower.includes(String(order.productCount));
  const hasOrderRef = !orderDigits || script.includes(orderDigits);
  return hasName && hasCount && hasOrderRef;
}

export async function classifyFollowUpIntent(
  callerText: string,
): Promise<"goodbye" | "repeat_order" | "other"> {
  if (isExplicitGoodbyeUtterance(callerText)) {
    return "goodbye";
  }
  const text = callerText.toLowerCase();
  if (/\b(repeat|say that again|order details|what did you find|summary)\b/.test(text)) {
    return "repeat_order";
  }
  return "other";
}

const lastSpokenByCall = new Map<string, string>();

/** Normalize speech for duplicate detection. */
export function normalizeSpeechForDedup(speech: string): string {
  return speech.replace(/\s+/g, " ").trim().toLowerCase();
}

export function isDuplicateSpokenSentence(callSid: string, speech: string): boolean {
  const last = lastSpokenByCall.get(callSid);
  if (!last) return false;
  return normalizeSpeechForDedup(last) === normalizeSpeechForDedup(speech);
}

export function recordLastSpokenSentence(callSid: string, speech: string): void {
  const trimmed = speech.trim();
  if (!trimmed) return;
  lastSpokenByCall.set(callSid, trimmed);
}

export function clearLastSpokenSentence(callSid: string): void {
  lastSpokenByCall.delete(callSid);
}

/** Rewrite a verbatim repeat so the caller does not hear the same line twice. */
export async function rewriteDuplicateSpokenResponse(
  duplicateSpeech: string,
  userMessage: string,
): Promise<string> {
  if (process.env.VITEST === "true") {
    return "Sure — what else can I help you with today?";
  }

  const apiKey = getConfig().OPENAI_API_KEY;
  if (!apiKey) {
    return "Sure — what else can I help you with today?";
  }

  try {
    const response = await getClient().chat.completions.create({
      model: getConfig().OPENAI_MODEL,
      max_tokens: 120,
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content:
            "Rewrite the bookstore voice agent line so it keeps the same meaning but uses different words. One or two short phone-friendly sentences. Never repeat the prior sentence verbatim.",
        },
        {
          role: "user",
          content: `Caller said: "${userMessage}"\nRepeated line to avoid: "${duplicateSpeech}"\nRewrite:`,
        },
      ],
    });
    const rewritten = response.choices[0]?.message?.content?.trim();
    if (
      rewritten &&
      normalizeSpeechForDedup(rewritten) !== normalizeSpeechForDedup(duplicateSpeech)
    ) {
      return rewritten;
    }
  } catch {
    // Fall through to safe fallback.
  }

  return "Sure — what else can I help you with today?";
}

/** Drop or rewrite speech that exactly matches the prior spoken sentence. */
export async function ensureUniqueSpokenResponse(
  callSid: string,
  speech: string,
  userMessage = "",
): Promise<string> {
  const trimmed = speech.trim();
  if (!trimmed) return trimmed;

  if (!isDuplicateSpokenSentence(callSid, trimmed)) {
    recordLastSpokenSentence(callSid, trimmed);
    return trimmed;
  }

  const rewritten = await rewriteDuplicateSpokenResponse(trimmed, userMessage);
  recordLastSpokenSentence(callSid, rewritten);
  return rewritten;
}

/** Background LLM note — runs in parallel with Shopify, never blocks first spoken chunk. */
export async function preAnalyzeOrderIntent(orderNumber: string): Promise<void> {
  const apiKey = getConfig().OPENAI_API_KEY;
  if (!apiKey) return;

  try {
    await getClient().chat.completions.create({
      model: getConfig().OPENAI_MODEL,
      max_tokens: 1,
      messages: [
        {
          role: "user",
          content: `Order lookup queued for ${orderNumber}.`,
        },
      ],
    });
  } catch {
    // Non-blocking warm-up — ignore failures.
  }
}
