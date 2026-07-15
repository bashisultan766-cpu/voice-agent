/**
 * Conversational turn engine: brand profile / CMS retrieve → LLM (optional) →
 * speech-safe 2–3 sentence reply. Callers never hear technical failures.
 */

import OpenAI from "openai";
import { getConfig } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { getWordPressApiClient, type WordPressApiClient } from "./wordpress_api.js";
import { brandOfflineFallbackSpeech, offTopicRedirectSpeech } from "./brandProfile.js";
import {
  buildRetrievalOnlySpeech,
  buildTurnMessages,
} from "./prompts.js";
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
}

const sessions = new Map<string, SessionMemory>();

/** Obvious off-domain prompts (newspaper agent only). */
const OFF_TOPIC_RE =
  /\b(python|javascript|code|program(ming)?|cook(ing)?|recipe|bitcoin|crypto|weather forecast|homework|math problem)\b/i;

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

function remember(session: SessionMemory, user: string, assistant: string): void {
  session.history.push({ role: "user", content: user });
  session.history.push({ role: "assistant", content: assistant });
  if (session.history.length > 20) {
    session.history = session.history.slice(-20);
  }
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

  const knowledge = await wp.retrieveForQuery(utterance);

  // Brand profile path (identity or CMS offline) — natural speech, no technical wording.
  if (knowledge.usedBrandProfile && knowledge.brandSpeech) {
    const history = input.history ?? session.history.slice(-8);
    const messages = buildTurnMessages({
      userUtterance: utterance,
      articles: [],
      categories: [],
      degraded: knowledge.degraded,
      usedBrandProfile: true,
      brandKnowledge: knowledge.brandKnowledge,
      history,
    });

    let speech: string;
    try {
      speech =
        (await maybeLlmSpeech(messages)) ??
        finalizeSpeech(knowledge.brandSpeech);
    } catch {
      speech = finalizeSpeech(knowledge.brandSpeech);
    }

    remember(session, utterance, speech);
    return {
      speech,
      degraded: Boolean(knowledge.degraded),
      articlesUsed: 0,
      usedBrandProfile: true,
      latencyMs: Date.now() - started,
    };
  }

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

  let speech: string;
  try {
    speech =
      (await maybeLlmSpeech(messages)) ??
      buildRetrievalOnlySpeech(knowledge.articles, {
        degraded: knowledge.degraded,
        brandSpeech: knowledge.brandSpeech,
      }) ??
      brandOfflineFallbackSpeech(utterance);
  } catch (err) {
    logger.error("mailcall_llm_failed", {
      callSid: input.callSid,
      error: err instanceof Error ? err.message : String(err),
    });
    speech =
      buildRetrievalOnlySpeech(knowledge.articles, {}) ??
      brandOfflineFallbackSpeech(utterance);
  }

  speech = finalizeSpeech(speech);
  remember(session, utterance, speech);

  return {
    speech,
    degraded: false,
    articlesUsed: knowledge.articles.length,
    latencyMs: Date.now() - started,
  };
}
