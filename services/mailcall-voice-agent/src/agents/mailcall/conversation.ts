/**
 * Conversational turn engine for Brook:
 * policy fast-paths → CMS retrieve → optional LLM + tools → speech-safe 2–3 sentences.
 */

import OpenAI from "openai";
import { getConfig } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { getWordPressApiClient, type WordPressApiClient } from "./wordpress_api.js";
import { brandOfflineFallbackSpeech, offTopicRedirectSpeech } from "./brandProfile.js";
import {
  buildProductCatalogSpeech,
  findPlanByUtterance,
  SCRIPTS,
} from "./businessRules.js";
import {
  buildRetrievalOnlySpeech,
  buildTurnMessages,
} from "./prompts.js";
import { executeMailCallTool, MAILCALL_TOOL_DEFINITIONS } from "./tools.js";
import { clampSpokenLength, truncateToSentences } from "./textCleaner.js";
import type { CallTurnResult } from "./types.js";
import { GREETING_SPEECH } from "./types.js";

export interface ConversationTurnInput {
  callSid: string;
  utterance: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

interface SessionMemory {
  history: Array<{ role: "user" | "assistant"; content: string }>;
  startedAtMs: number;
}

const sessions = new Map<string, SessionMemory>();

const OFF_TOPIC_RE =
  /\b(python|javascript|code|program(ming)?|cook(ing)?|recipe|bitcoin|crypto|weather forecast|homework|math problem)\b/i;

const PRICING_RE =
  /\b(price|pricing|plan|plans|cost|how much|subscription|what('s| is) included|sections?)\b/i;

const REFUND_RE = /\b(refund|cancel(lation|ling)?|return(s)?|money back|credit)\b/i;

const ADDRESS_CHANGE_RE =
  /\b(address change|change (of )?address|moved|inmate moved|new facility|forward(ing)?)\b/i;

const DELAY_RE =
  /\b(delay(ed)?|late|hasn'?t (arrived|come)|not (received|gotten)|where is (my|the) (paper|issue|order))\b/i;

const UPSET_RE = /\b(angry|furious|ridiculous|unacceptable|scam|lawsuit|attorney)\b/i;

function getSession(callSid: string): SessionMemory {
  let s = sessions.get(callSid);
  if (!s) {
    s = { history: [], startedAtMs: Date.now() };
    sessions.set(callSid, s);
  }
  return s;
}

export function clearSession(callSid: string): void {
  sessions.delete(callSid);
}

/** Test helper — backdate session start for transfer gating. */
export function setSessionStartedAt(callSid: string, startedAtMs: number): void {
  const s = getSession(callSid);
  s.startedAtMs = startedAtMs;
}

export function greetingSpeech(): string {
  return GREETING_SPEECH;
}

function finalizeSpeech(raw: string): string {
  return clampSpokenLength(truncateToSentences(raw, 3), 55);
}

function remember(session: SessionMemory, user: string, assistant: string): void {
  session.history.push({ role: "user", content: user });
  session.history.push({ role: "assistant", content: assistant });
  if (session.history.length > 20) {
    session.history = session.history.slice(-20);
  }
}

/** Deterministic policy / product answers when OpenAI is unavailable or for crisp voice UX. */
function matchPolicyFastPath(utterance: string): string | null {
  if (REFUND_RE.test(utterance)) {
    return `I understand. ${SCRIPTS.refundFinal}`;
  }
  if (ADDRESS_CHANGE_RE.test(utterance)) {
    return `Not a problem. ${SCRIPTS.addressChange}`;
  }
  // Upset + delay: when OpenAI is available, fall through so send_support_escalation can run.
  if (UPSET_RE.test(utterance) && DELAY_RE.test(utterance)) {
    if (!getConfig().MAILCALL_OPENAI_API_KEY) {
      return SCRIPTS.escalation;
    }
    return null;
  }
  if (DELAY_RE.test(utterance)) {
    return SCRIPTS.delayedDelivery;
  }
  if (PRICING_RE.test(utterance) || findPlanByUtterance(utterance)) {
    const plan = findPlanByUtterance(utterance);
    return buildProductCatalogSpeech(plan?.sku);
  }
  return null;
}

async function maybeLlmSpeechWithTools(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  ctx: { callSid: string; callStartedAtMs: number },
): Promise<{ speech: string | null; transferToNumber?: string }> {
  const cfg = getConfig();
  if (!cfg.MAILCALL_OPENAI_API_KEY) return { speech: null };

  const client = new OpenAI({ apiKey: cfg.MAILCALL_OPENAI_API_KEY });
  const working: OpenAI.Chat.ChatCompletionMessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let transferToNumber: string | undefined;

  for (let round = 0; round < 3; round++) {
    const completion = await client.chat.completions.create({
      model: cfg.MAILCALL_OPENAI_MODEL,
      temperature: 0.35,
      max_tokens: 180,
      messages: working,
      tools: MAILCALL_TOOL_DEFINITIONS,
      tool_choice: "auto",
    });

    const choice = completion.choices[0]?.message;
    if (!choice) break;

    const toolCalls = choice.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const text = choice.content?.trim();
      return { speech: text ? finalizeSpeech(text) : null, transferToNumber };
    }

    working.push({
      role: "assistant",
      content: choice.content ?? null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      if (call.type !== "function") continue;
      const result = await executeMailCallTool(call.function.name, call.function.arguments, ctx);
      if (result.transferToNumber) transferToNumber = result.transferToNumber;
      working.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({
          ...result.toolPayload,
          spoken_hint: result.spokenHint,
        }),
      });
    }
  }

  return { speech: null, transferToNumber };
}

export async function processConversationTurn(
  input: ConversationTurnInput,
  wp: WordPressApiClient = getWordPressApiClient(),
): Promise<CallTurnResult> {
  const started = Date.now();
  const utterance = input.utterance.trim();
  const session = getSession(input.callSid);

  if (!utterance) {
    return {
      speech: "Sorry, I didn't catch that. Could you say that again?",
      degraded: false,
      articlesUsed: 0,
      latencyMs: Date.now() - started,
    };
  }

  if (OFF_TOPIC_RE.test(utterance)) {
    const speech = finalizeSpeech(offTopicRedirectSpeech());
    remember(session, utterance, speech);
    return {
      speech,
      degraded: false,
      articlesUsed: 0,
      usedBrandProfile: true,
      latencyMs: Date.now() - started,
    };
  }

  const policySpeech = matchPolicyFastPath(utterance);
  if (policySpeech) {
    const speech = finalizeSpeech(policySpeech);
    remember(session, utterance, speech);
    return {
      speech,
      degraded: false,
      articlesUsed: 0,
      latencyMs: Date.now() - started,
    };
  }

  // Live RAG before LLM: extract search terms, max 2 articles, hard 1000ms timeout.
  const knowledge = await wp.retrieveForLiveTurn(utterance);
  const history = input.history ?? session.history.slice(-8);
  const messages = buildTurnMessages({
    userUtterance: utterance,
    articles: knowledge.articles,
    categories: knowledge.categories,
    degraded: knowledge.degraded,
    usedBrandProfile: knowledge.usedBrandProfile,
    brandKnowledge: knowledge.brandKnowledge,
    history,
  });

  logger.info("mailcall_turn_rag", {
    callSid: input.callSid,
    articlesUsed: knowledge.articles.length,
    degraded: knowledge.degraded,
    usedBrandProfile: Boolean(knowledge.usedBrandProfile),
    ragLatencyMs: knowledge.latencyMs,
  });

  let speech: string;
  let transferToNumber: string | undefined;

  try {
    const llm = await maybeLlmSpeechWithTools(messages, {
      callSid: input.callSid,
      callStartedAtMs: session.startedAtMs,
    });
    transferToNumber = llm.transferToNumber;

    if (llm.speech) {
      speech = llm.speech;
    } else if (knowledge.usedBrandProfile && knowledge.brandSpeech) {
      speech = finalizeSpeech(knowledge.brandSpeech);
    } else {
      speech = finalizeSpeech(
        buildRetrievalOnlySpeech(knowledge.articles, {
          degraded: knowledge.degraded,
          brandSpeech: knowledge.brandSpeech,
        }) ?? brandOfflineFallbackSpeech(utterance),
      );
    }
  } catch (err) {
    logger.error("mailcall_llm_failed", {
      callSid: input.callSid,
      error: err instanceof Error ? err.message : String(err),
    });
    speech = finalizeSpeech(
      (knowledge.usedBrandProfile && knowledge.brandSpeech) ||
        buildRetrievalOnlySpeech(knowledge.articles, {}) ||
        brandOfflineFallbackSpeech(utterance),
    );
  }

  remember(session, utterance, speech);

  return {
    speech,
    degraded: Boolean(knowledge.degraded),
    articlesUsed: knowledge.articles.length,
    usedBrandProfile: knowledge.usedBrandProfile,
    transferToNumber,
    latencyMs: Date.now() - started,
  };
}
