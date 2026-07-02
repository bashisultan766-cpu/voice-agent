import OpenAI from "openai";
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { extractOrderNumberFromSpeech, normalizeOrderNumber } from "../utils/formatter.js";
import { ORDER_EXTRACTION_SYSTEM_PROMPT, SPEECH_POLISH_SYSTEM_PROMPT } from "../agents/prompt.js";
import type { StructuredOrder } from "../types/order.js";
import { safeCustomerFacingOrder } from "../utils/security.js";

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

export async function extractOrderNumberWithLlm(callerText: string): Promise<string | null> {
  const regexGuess = extractOrderNumberFromSpeech(callerText);
  if (regexGuess) return regexGuess;

  try {
    const response = await getClient().chat.completions.create({
      model: getConfig().OPENAI_MODEL,
      temperature: 0,
      max_tokens: 32,
      messages: [
        { role: "system", content: ORDER_EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: callerText },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content) as { order_number?: string | null };
    if (!parsed.order_number) return null;
    const normalized = normalizeOrderNumber(parsed.order_number);
    return normalized || null;
  } catch (err) {
    logger.warn("llm_order_extraction_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function polishSpeechScript(
  deterministicScript: string,
  order: StructuredOrder,
): Promise<string> {
  const safeOrder = safeCustomerFacingOrder(order);

  try {
    const response = await getClient().chat.completions.create({
      model: getConfig().OPENAI_MODEL,
      temperature: 0.2,
      max_tokens: 500,
      messages: [
        { role: "system", content: SPEECH_POLISH_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            required_script_elements: deterministicScript,
            order_facts: safeOrder,
          }),
        },
      ],
    });

    const polished = response.choices[0]?.message?.content?.trim();
    if (!polished) return deterministicScript;

    if (!containsRequiredFacts(polished, safeOrder)) {
      logger.warn("llm_polish_rejected_hallucination", { orderNumber: safeOrder.orderNumber });
      return deterministicScript;
    }

    return polished;
  } catch (err) {
    logger.warn("llm_polish_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return deterministicScript;
  }
}

function containsRequiredFacts(script: string, order: StructuredOrder): boolean {
  const lower = script.toLowerCase();
  const orderDigits = order.orderNumber.replace(/\D/g, "");
  const nameToken = order.customerName.split(" ")[0]?.toLowerCase();
  const hasName = !nameToken || lower.includes(nameToken);
  const hasCount = lower.includes(String(order.productCount));
  const hasOrderRef = !orderDigits || script.includes(orderDigits);
  return hasName && hasCount && hasOrderRef;
}

export async function classifyFollowUpIntent(
  callerText: string,
): Promise<"goodbye" | "repeat_order" | "other"> {
  const text = callerText.toLowerCase();
  if (/\b(no|nothing|that's all|that is all|goodbye|bye|hang up|i'm good|im good)\b/.test(text)) {
    return "goodbye";
  }
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
      temperature: 0,
      max_tokens: 16,
      messages: [
        {
          role: "system",
          content: "Reply with one word: lookup. No other output.",
        },
        { role: "user", content: `order ${orderNumber}` },
      ],
    });
  } catch {
    // Non-critical warm-up only.
  }
}
