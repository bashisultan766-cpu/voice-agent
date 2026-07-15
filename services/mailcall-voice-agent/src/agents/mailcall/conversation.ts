/**
 * Conversational turn engine: retrieve WP knowledge → LLM (optional) →
 * speech-safe 2–3 sentence reply with hard fallbacks.
 */

import OpenAI from "openai";
import { getConfig } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { getWordPressApiClient, type WordPressApiClient } from "./wordpress_api.js";
import {
  buildRetrievalOnlySpeech,
  buildTurnMessages,
} from "./prompts.js";
import { clampSpokenLength, truncateToSentences } from "./textCleaner.js";
import type { CallTurnResult } from "./types.js";
import { GREETING_SPEECH, WP_UNAVAILABLE_SPEECH } from "./types.js";

export interface ConversationTurnInput {
  callSid: string;
  utterance: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

interface SessionMemory {
  history: Array<{ role: "user" | "assistant"; content: string }>;
}

const sessions = new Map<string, SessionMemory>();

function getSession(callSid: string): SessionMemory {
  let s = sessions.get(callSid);
  if (!s) {
    s = { history: [] };
    sessions.set(callSid, s);
  }
  return s;
}

export function clearSession(callSid: string): void {
  sessions.delete(callSid);
}

export function greetingSpeech(): string {
  return GREETING_SPEECH;
}

function finalizeSpeech(raw: string): string {
  return clampSpokenLength(truncateToSentences(raw, 3), 55);
}

async function maybeLlmSpeech(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): Promise<string | null> {
  const cfg = getConfig();
  if (!cfg.MAILCALL_OPENAI_API_KEY) return null;

  const client = new OpenAI({ apiKey: cfg.MAILCALL_OPENAI_API_KEY });
  const completion = await client.chat.completions.create({
    model: cfg.MAILCALL_OPENAI_MODEL,
    temperature: 0.4,
    max_tokens: 160,
    messages,
  });

  const text = completion.choices[0]?.message?.content?.trim();
  return text ? finalizeSpeech(text) : null;
}

export async function processConversationTurn(
  input: ConversationTurnInput,
  wp: WordPressApiClient = getWordPressApiClient(),
): Promise<CallTurnResult> {
  const started = Date.now();
  const utterance = input.utterance.trim();
  if (!utterance) {
    return {
      speech: "Sorry, I didn't catch that. Could you say that again?",
      degraded: false,
      articlesUsed: 0,
      latencyMs: Date.now() - started,
    };
  }

  const knowledge = await wp.retrieveForQuery(utterance);

  if (knowledge.degraded) {
    logger.warn("mailcall_turn_degraded", {
      callSid: input.callSid,
      reason: knowledge.degradeReason,
      wpLatencyMs: knowledge.latencyMs,
    });
    const speech = WP_UNAVAILABLE_SPEECH;
    const session = getSession(input.callSid);
    session.history.push({ role: "user", content: utterance });
    session.history.push({ role: "assistant", content: speech });
    return {
      speech,
      degraded: true,
      articlesUsed: 0,
      latencyMs: Date.now() - started,
    };
  }

  const session = getSession(input.callSid);
  const history = input.history ?? session.history.slice(-8);

  const messages = buildTurnMessages({
    userUtterance: utterance,
    articles: knowledge.articles,
    categories: knowledge.categories,
    degraded: knowledge.degraded,
    degradeReason: knowledge.degradeReason,
    history,
  });

  let speech: string;
  try {
    speech =
      (await maybeLlmSpeech(messages)) ??
      buildRetrievalOnlySpeech(knowledge.articles, false) ??
      WP_UNAVAILABLE_SPEECH;
  } catch (err) {
    logger.error("mailcall_llm_failed", {
      callSid: input.callSid,
      error: err instanceof Error ? err.message : String(err),
    });
    speech =
      buildRetrievalOnlySpeech(knowledge.articles, false) ??
      "I found some coverage, but I'm having trouble forming a reply. Could you ask that another way?";
  }

  speech = finalizeSpeech(speech);

  session.history.push({ role: "user", content: utterance });
  session.history.push({ role: "assistant", content: speech });
  if (session.history.length > 20) {
    session.history = session.history.slice(-20);
  }

  return {
    speech,
    degraded: false,
    articlesUsed: knowledge.articles.length,
    latencyMs: Date.now() - started,
  };
}
