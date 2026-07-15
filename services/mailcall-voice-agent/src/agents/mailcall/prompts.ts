/**
 * Master system prompt — Brook, Senior Editorial & Customer Support Representative.
 * Voice-safe, domain-bounded, shielded from technical leakage.
 */

import type { MailCallArticle, MailCallCategory } from "./types.js";
import { buildBrandProfileKnowledgeBlock } from "./brandProfile.js";
import {
  AGENT_FIRST_NAME,
  AGENT_TITLE,
  PUBLICATION_NAME,
  SCRIPTS,
  SUPPORT_EMAIL,
  buildBusinessKnowledgeBlock,
} from "./businessRules.js";

export const AGENT_NAME = `${AGENT_FIRST_NAME}, ${AGENT_TITLE}`;
export { PUBLICATION_NAME };

export function buildSystemPrompt(now: Date = new Date()): string {
  const utcIso = now.toISOString();
  return `You are ${AGENT_FIRST_NAME}, ${AGENT_TITLE} at ${PUBLICATION_NAME} (also known as Mail Call Communication).

IDENTITY & CORE ROLE:
- Empathetic, calm, deeply respectful, and highly professional.
- You speak with family members, friends, and loved ones supporting an incarcerated individual. Treat every caller with profound kindness and patience.
- Tone: natural, warm, conversational, and unhurried. Speak clearly and spell out critical details (names, numbers, addresses) when collecting information.

VOICE OPTIMIZATION:
- Hard turn limit: maximum 2–3 concise spoken sentences. Never dump paragraphs, lists, or markdown.
- No technical leakage: never say database, API, fetching, error, system, tool, WordPress, URL, JSON, server, timeout, or similar jargon.
- Dynamic time reference: for date, time, or scheduling, use the authoritative clock below (UTC instant ${utcIso}) and Eastern office-hours rules in the business context.
- Conversational signposts: "Not a problem," "I can help with that," "You're very welcome," "Let me walk you through this."

BUSINESS GUARDRAILS:
- Office hours: Monday–Friday, 10:00 AM–5:00 PM Eastern. Closed weekends and major U.S. holidays.
- Transfer: call transfer_to_number ONLY when office hours are open AND the call has lasted over 5 minutes. If closed, do not transfer — continue helping, offer callback instructions, or the voicemail guidance.
- Refunds: ALL SALES ARE FINAL. Never issue, promise, or imply refunds, credits, or cancellations. Use: "${SCRIPTS.refundFinal}"
- Address changes: free. Instruct email to ${SUPPORT_EMAIL} (say it as support at mailcallnewspaper dot com). Remind facility forwarding up to 30 days and to verify the new facility accepts printed newspapers.
- Delayed delivery: use the delayed-delivery script when appropriate. For upset callers, offer the escalation script.
- First issue timeline: issues ship monthly; first issue arrives within 2–4 weeks.

CONVERSATIONAL PHASES (use tools when needed):
1) Exploration & Pricing — MailCallProduct for plans/sections/inclusions.
2) Order Lookup — GetOrders after collecting order number (preferred), inmate number, or customer name/email. Translate results into soft, reassuring speech.
3) Transaction — PlaceOrder only after explicit purchase intent. Verify SKU with MailCallSku. Collect customer first/last/email (normalize spoken "at"→@ and "dot"→.). Then inmate name, inmate number, facility name, and facility mailing address.

DOMAIN:
- Stay inside MailCall Newspaper: subscriptions, deliveries, inmate mailing support, newsroom identity, and published coverage when knowledge is provided.
- Off-topic redirect: "${SCRIPTS.offTopic}"
- Do not invent order statuses, confirmations, or headlines missing from tool results or knowledge context.`;
}

/** @deprecated Prefer buildSystemPrompt() for fresh clock context. */
export const SYSTEM_PROMPT = buildSystemPrompt();

export const GREETING_PROMPT =
  `Greet the caller briefly as ${AGENT_FIRST_NAME} from ${PUBLICATION_NAME} and ask how you can help. One or two warm sentences only.`;

export function buildKnowledgeContextBlock(
  articles: MailCallArticle[],
  categories: MailCallCategory[],
  options?: {
    degraded?: boolean;
    usedBrandProfile?: boolean;
    brandKnowledge?: string;
    now?: Date;
  },
): string {
  const business = buildBusinessKnowledgeBlock(options?.now ?? new Date());

  if (options?.usedBrandProfile || options?.degraded) {
    return [
      business,
      options.brandKnowledge ?? buildBrandProfileKnowledgeBlock(),
    ].join("\n\n");
  }

  const articleLines =
    articles.length === 0
      ? ["No matching coverage found. Prefer product, order, or policy help if that fits the caller."]
      : articles.slice(0, 6).map((a, i) => {
          const bits = [
            `${i + 1}. Title: ${a.title}`,
            a.spokenSummary ? `   Summary: ${a.spokenSummary}` : null,
            a.date ? `   Date: ${a.date.slice(0, 10)}` : null,
          ].filter(Boolean);
          return bits.join("\n");
        });

  const categoryLines =
    categories.length === 0
      ? []
      : [
          "Available sections:",
          ...categories.slice(0, 20).map((c) => `- ${c.name}${c.count ? ` (${c.count})` : ""}`),
        ];

  return [
    business,
    "COVERAGE CONTEXT (use only when discussing articles):",
    ...articleLines,
    ...categoryLines,
  ].join("\n");
}

export function buildTurnMessages(input: {
  userUtterance: string;
  articles: MailCallArticle[];
  categories: MailCallCategory[];
  degraded?: boolean;
  usedBrandProfile?: boolean;
  brandKnowledge?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  now?: Date;
}): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const now = input.now ?? new Date();
  const knowledge = buildKnowledgeContextBlock(input.articles, input.categories, {
    degraded: input.degraded,
    usedBrandProfile: input.usedBrandProfile,
    brandKnowledge: input.brandKnowledge,
    now,
  });

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: buildSystemPrompt(now) },
    { role: "system", content: knowledge },
  ];

  for (const turn of input.history ?? []) {
    messages.push({ role: turn.role, content: turn.content });
  }

  messages.push({ role: "user", content: input.userUtterance });
  return messages;
}

/** Deterministic retrieval-only speech when OpenAI is unavailable. */
export function buildRetrievalOnlySpeech(
  articles: MailCallArticle[],
  options?: { degraded?: boolean; brandSpeech?: string },
): string | null {
  if (options?.brandSpeech) return options.brandSpeech;
  if (options?.degraded) return null;
  if (articles.length === 0) {
    return "I can help with that. Are you asking about a subscription plan, a delivery, or something about our newspaper coverage?";
  }
  const top = articles[0]!;
  const body = top.spokenSummary || top.excerpt || top.title;
  const lead =
    top.title && body && !body.toLowerCase().includes(top.title.toLowerCase().slice(0, 12))
      ? `${top.title}. ${body}`
      : body;
  const follow =
    articles.length > 1
      ? ` I also have related coverage on ${articles[1]!.title}. Would you like that next?`
      : " Would you like a bit more on that piece?";
  return `${lead}.${follow}`.replace(/\.\./g, ".");
}
