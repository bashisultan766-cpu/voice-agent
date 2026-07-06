/**
 * Lightweight LLM helpers for follow-up classification and background analysis.
 */
import OpenAI from "openai";
import { getConfig } from "../config.js";
import type { StructuredOrder } from "../types/order.js";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: getConfig().OPENAI_API_KEY });
  }
  return client;
}

/** Explicit farewell only — bare "no" must NOT end the call. */
export function isExplicitGoodbyeUtterance(callerText: string): boolean {
  const text = callerText.toLowerCase().trim();
  if (!text) return false;
  return /\b(goodbye|good bye|bye|see you|see ya|hang up|hangup|that'?s all|that is all|nothing else|i'?m done|im done|end call|end the call)\b/i.test(
    text,
  );
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
