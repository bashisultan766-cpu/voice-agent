/**
 * Brain analyzer — intent + slot extraction ONLY. Never decides or calls tools.
 */
import OpenAI from "openai";
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { extractOrderNumberFromSpeech } from "../utils/formatter.js";
import { extractIsbnFromSpeech } from "../utils/productSearchNormalize.js";
import { BRAIN_CLASSIFICATION_PROMPT } from "./conversationBrainPrompt.js";
import {
  computeMissingSlots,
  type GateIntent,
} from "./toolDecisionGate.js";
import type { CallState } from "../memory/callStateStore.js";
import {
  mergeProductSlots,
  parseProductSlotsFromSpeech,
} from "./productSlotPhase.js";
import type { CallSession, ProductSearchSlots } from "../types/order.js";

export interface BrainAnalysis {
  intent: GateIntent;
  missingSlots: Array<"isbn" | "title">;
  /** Merged view for prompts/logging only — not written to CallState directly. */
  slots: ProductSearchSlots;
  /** Delta extracted this turn — sole input to CallState merge. */
  deltaSlots: ProductSearchSlots;
  orderNumber: string | null;
  userMessage: string;
  confidence: number;
  source: "regex" | "openai" | "default";
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

export async function analyzeBrainTurn(
  userMessage: string,
  session: CallSession,
  callState?: CallState,
): Promise<BrainAnalysis> {
  const text = (userMessage ?? "").trim();
  const awaiting = callState?.awaitingInput ?? "none";
  const parsed = parseProductSlotsFromSpeech(text, awaiting);
  const persistedSlots: ProductSearchSlots = callState
    ? {
        isbn: callState.slots.isbn,
        title: callState.slots.title,
        wantsRecommendations: callState.slots.wantsRecommendations,
      }
    : session.productSlots ?? {};
  const slots = mergeProductSlots(
    mergeProductSlots(session.productSlots, persistedSlots),
    parsed,
  );
  const orderNumber = extractOrderNumberFromSpeech(text);

  const regex = classifyIntentRegex(text);
  if (regex) {
    return {
      intent: regex.intent,
      missingSlots: computeMissingSlots(slots),
      slots,
      deltaSlots: parsed,
      orderNumber,
      userMessage: text,
      confidence: regex.confidence,
      source: "regex",
    };
  }

  const llm = await classifyIntentWithLlm(text);
  if (llm) {
    return {
      intent: llm.intent,
      missingSlots: computeMissingSlots(slots),
      slots,
      deltaSlots: parsed,
      orderNumber,
      userMessage: text,
      confidence: llm.confidence,
      source: "openai",
    };
  }

  return {
    intent: "unknown",
    missingSlots: computeMissingSlots(slots),
    slots,
    deltaSlots: parsed,
    orderNumber,
    userMessage: text,
    confidence: 0.35,
    source: "default",
  };
}

function classifyIntentRegex(text: string): { intent: GateIntent; confidence: number } | null {
  if (
    /^(hi|hello|hey|howdy|good\s+(morning|afternoon|evening))[\s!.?,]*$/i.test(text) ||
    /\b(how\s+are\s+you|how'?s\s+it\s+going|what do you do|who are you|your hours)\b/i.test(text)
  ) {
    return { intent: "general", confidence: 0.95 };
  }

  if (/\b(order|tracking|track|shipment|where\s+is\s+my\s+order|my\s+order|refund)\b/i.test(text)) {
    return { intent: "order", confidence: 0.95 };
  }

  if (
    /\b(buy|purchase|want to (buy|order)|how (do|can) (i|you) (buy|order|get)|book|books|magazine|isbn|title|do you have|looking for|i need a book)\b/i.test(
      text,
    ) ||
    extractIsbnFromSpeech(text)
  ) {
    return { intent: "product", confidence: 0.9 };
  }

  return null;
}

async function classifyIntentWithLlm(
  speech: string,
): Promise<{ intent: GateIntent; confidence: number } | null> {
  try {
    const response = await getClient().chat.completions.create({
      model: getConfig().OPENAI_MODEL,
      temperature: 0,
      max_tokens: 120,
      messages: [
        { role: "system", content: BRAIN_CLASSIFICATION_PROMPT },
        { role: "user", content: speech },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as {
      intent?: string;
      confidence?: number;
      missingSlots?: string[];
    };

    const intents: GateIntent[] = ["order", "product", "general", "unknown"];
    if (!parsed.intent || !intents.includes(parsed.intent as GateIntent)) return null;

    return {
      intent: parsed.intent as GateIntent,
      confidence:
        typeof parsed.confidence === "number"
          ? Math.min(1, Math.max(0, parsed.confidence))
          : 0.7,
    };
  } catch (err) {
    logger.warn("brain_classification_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
