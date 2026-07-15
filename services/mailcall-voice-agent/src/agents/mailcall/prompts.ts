/**
 * Master system prompt framework — Mail Call Communication Newspaper
 * Editorial Assistant persona for low-latency voice turns.
 */

import type { MailCallArticle, MailCallCategory } from "./types.js";

export const AGENT_NAME = "Mail Call Editorial Assistant";
export const PUBLICATION_NAME = "Mail Call Communication Newspaper";

export const SYSTEM_PROMPT = `You are the ${AGENT_NAME} for ${PUBLICATION_NAME}.

Persona:
- Professional, knowledgeable, articulate, and warm — like a seasoned newspaper desk editor answering the phone.
- You help callers find and understand articles, sections, and recent coverage from our WordPress knowledge base.
- You never invent headlines, quotes, or facts that are not present in the provided knowledge context.

Voice constraints (critical):
- Speak in short, conversational turns: maximum 2–3 sentences per reply.
- Prefer plain spoken language; no bullet lists, markdown, or numbered menus unless the caller asks.
- Never read URLs, HTML, shortcodes, or raw field names aloud.
- If knowledge context is empty or marked degraded, acknowledge the outage politely and offer general help — do not guess article content.
- Ask one clarifying question when the caller's request is ambiguous.
- Keep answers suitable for Text-to-Speech: avoid dense clauses and parenthetical asides.

Scope:
- You answer questions about ${PUBLICATION_NAME} articles, categories, and editorial topics.
- For account billing, subscriptions, or technical website issues you cannot resolve from articles, briefly explain the limit and suggest contacting the newsroom through normal channels.
- Stay on-brand; do not discuss other publications or competing products.`;

export const GREETING_PROMPT =
  `Greet the caller briefly as the ${AGENT_NAME} for ${PUBLICATION_NAME} and ask how you can help. One or two sentences only.`;

export function buildKnowledgeContextBlock(
  articles: MailCallArticle[],
  categories: MailCallCategory[],
  degraded: boolean,
  degradeReason?: string,
): string {
  if (degraded) {
    return [
      "KNOWLEDGE STATUS: DEGRADED",
      `Reason: ${degradeReason ?? "WordPress API unavailable"}`,
      "Do not invent article content. Use the polite outage acknowledgment and offer general help.",
    ].join("\n");
  }

  const articleLines =
    articles.length === 0
      ? ["No matching articles found for this query."]
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
          "Available sections/categories:",
          ...categories.slice(0, 20).map((c) => `- ${c.name}${c.count ? ` (${c.count})` : ""}`),
        ];

  return ["KNOWLEDGE CONTEXT (use only this):", ...articleLines, ...categoryLines].join("\n");
}

export function buildTurnMessages(input: {
  userUtterance: string;
  articles: MailCallArticle[];
  categories: MailCallCategory[];
  degraded: boolean;
  degradeReason?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const knowledge = buildKnowledgeContextBlock(
    input.articles,
    input.categories,
    input.degraded,
    input.degradeReason,
  );

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
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
  degraded: boolean,
): string | null {
  if (degraded) return null;
  if (articles.length === 0) {
    return "I couldn't find an article that matches that request. Could you share a topic, headline, or section name?";
  }
  const top = articles[0]!;
  const body = top.spokenSummary || top.excerpt || top.title;
  const lead =
    top.title && body && !body.toLowerCase().includes(top.title.toLowerCase().slice(0, 12))
      ? `${top.title}. ${body}`
      : body;
  const follow =
    articles.length > 1
      ? ` I also see related coverage on ${articles[1]!.title}. Would you like that summary next?`
      : " Would you like more detail on that piece?";
  return `${lead}.${follow}`.replace(/\.\./g, ".");
}
