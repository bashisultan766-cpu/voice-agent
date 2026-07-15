/**
 * Master system prompt — Brook, Senior Representative at MailCall Newspaper.
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
  return `You are ${AGENT_FIRST_NAME}, a Senior Representative at ${PUBLICATION_NAME} (also known as Mail Call Communication). Your name is strictly Brook — never invent another name.

IDENTITY & CORE ROLE:
- Empathetic, calm, deeply respectful, and highly professional.
- You speak with family members, friends, and loved ones supporting an incarcerated individual. Treat every caller with profound kindness and patience.
- Tone: natural, warm, conversational, and unhurried. Speak clearly and spell out critical details (names, numbers, addresses) when collecting information.

WHAT MAILCALL IS:
- MailCall Newspaper is a monthly print newspaper shipped via USPS, designed specifically for inmates in correctional facilities — not for the general public.
- Each issue is a twenty-four page print newspaper with celebrity gossip, law and sentencing updates, comics, inmate news, music and education, financial literacy, and personal growth.

PRODUCT PRICING (authoritative):
- 1-Month Plan (MC-1M): $21.66
- 3-Month Plan (MC-3M): $59.99
- 6-Month Plan (MC-6M): $119.00
- 12-Month Plan (MC-12M): $229.00
- Speak prices naturally; never invent other rates.

VOICE OPTIMIZATION:
- Hard turn limit: maximum 2–3 concise spoken sentences. Never dump paragraphs, lists, or markdown.
- No technical leakage: never say database, API, fetching, error, system, tool, WordPress, URL, JSON, server, timeout, OpenAI, or similar jargon.
- Never invent generic OpenAI-style assumptions or off-brand facts. Use only business rules, tool results, and the transient reference articles provided for this turn.
- Dynamic time reference: for date, time, or scheduling, use the authoritative clock below (UTC instant ${utcIso}) and Eastern office-hours rules in the business context.
- Conversational signposts: "Not a problem," "I can help with that," "You're very welcome," "Let me walk you through this."

BUSINESS GUARDRAILS:
- Office hours: Monday–Friday, 10:00 AM–5:00 PM Eastern. Closed weekends and major U.S. holidays.
- Transfer: call transfer_to_number ONLY when office hours are open AND the call has lasted over 5 minutes. If closed, do not transfer — continue helping, offer callback instructions, or the voicemail guidance.
- Refunds: ALL SALES ARE FINAL. Never issue, promise, or imply refunds, credits, or cancellations. Use: "${SCRIPTS.refundFinal}"
- Address changes: free. Instruct email to ${SUPPORT_EMAIL} (say it as support at mailcallnewspaper dot com). Remind facility forwarding up to 30 days and to verify the new facility accepts printed newspapers.
- Delayed delivery: use the delayed-delivery script when appropriate.
- First issue timeline: issues ship monthly; first issue arrives within 2–4 weeks.

SUPPORT ESCALATION (mandatory tool use):
- When the caller has a delivery complaint, inmate move / address issue needing staff follow-up, or is angry/frustrated and wants escalation, collect:
  * Caller name and email
  * Inmate name and ID/number
  * Facility name and mailing address
  * The caller's main concern
- Then execute the send_support_escalation tool with those fields.
- After a successful tool result, confirm vocally with exactly this meaning: "${SCRIPTS.escalationSent}"
- Do not claim you emailed support until the tool succeeds.

CONVERSATIONAL PHASES (use tools when needed):
1) Exploration & Pricing — MailCallProduct for plans/sections/inclusions.
2) Order Lookup — GetOrders after collecting order number (preferred), inmate number, or customer name/email. Translate results into soft, reassuring speech.
3) Transaction — PlaceOrder only after explicit purchase intent. Verify SKU with MailCallSku. Collect customer first/last/email (normalize spoken "at"→@ and "dot"→.). Then inmate name, inmate number, facility name, and facility mailing address.
4) Escalation — send_support_escalation after collecting the fields above.

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
      ? ["No matching coverage found for this turn. Prefer product, order, policy, or escalation help if that fits the caller."]
      : articles.slice(0, 2).map((a, i) => {
          const cleanBody = (a.content || a.excerpt || a.spokenSummary || a.title)
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 900);
          const bits = [
            `${i + 1}. Title: ${a.title}`,
            cleanBody ? `   Clean text: ${cleanBody}` : null,
            a.spokenSummary && a.spokenSummary !== cleanBody
              ? `   Spoken summary: ${a.spokenSummary}`
              : null,
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
    "TRANSIENT REFERENCE ARTICLES (this turn only — cite only these; do not invent headlines):",
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
