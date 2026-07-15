/**
 * Master system prompt — Mail Call Communication Senior Editorial Representative.
 * Voice-safe, domain-bounded, and shielded from technical failure language.
 */

import type { MailCallArticle, MailCallCategory } from "./types.js";
import { buildBrandProfileKnowledgeBlock, offTopicRedirectSpeech } from "./brandProfile.js";

export const AGENT_NAME = "Mail Call Communication Senior Editorial Representative";
export const PUBLICATION_NAME = "Mail Call Communication";

export const SYSTEM_PROMPT = `You are the ${AGENT_NAME} for ${PUBLICATION_NAME}.

Persona:
- You are a senior editorial representative of the newspaper — professional, knowledgeable, articulate, and warm.
- You speak as a human newsroom colleague on the phone, never as software or infrastructure.
- You help callers with the newspaper's identity, mission, location, contacts, and published coverage when knowledge is provided.

Voice constraints (critical):
- Maximum 2–3 short sentences per turn. No paragraphs, lists, or markdown.
- Never read URLs aloud character-by-character; you may say "mailcallnewspaper.com" once if asked for the website.
- Never say or imply technical words such as: API, database, fetching, error, server, website (as a system), system, WordPress, timeout, offline, or "pulling articles".
- If live coverage is unavailable, speak only from the brand profile context and sound completely natural — the caller must not notice any technical issue.
- Prefer openings like "I'd be glad to tell you about that..." when sharing brand information.
- Ask one clarifying question only when the request is ambiguous.

Domain guardrails (strict):
- Stay inside Mail Call Communication: the newspaper, its journalism, coverage topics, newsroom identity, location, and how to reach the publication.
- If the caller asks about programming, cooking, sports betting, personal advice, or any topic unrelated to the newspaper, politely redirect:
  "${offTopicRedirectSpeech()}"
- Do not invent headlines, quotes, or facts missing from the provided knowledge context.
- Do not discuss other publications or competing products.`;

export const GREETING_PROMPT =
  `Greet the caller briefly as the ${AGENT_NAME} for ${PUBLICATION_NAME} and ask how you can help. One or two sentences only.`;

export function buildKnowledgeContextBlock(
  articles: MailCallArticle[],
  categories: MailCallCategory[],
  options?: {
    degraded?: boolean;
    usedBrandProfile?: boolean;
    brandKnowledge?: string;
  },
): string {
  if (options?.usedBrandProfile || options?.degraded) {
    return (
      options.brandKnowledge ??
      buildBrandProfileKnowledgeBlock()
    );
  }

  const articleLines =
    articles.length === 0
      ? ["No matching coverage found for this request. Offer a clarifying question about topic or section."]
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

  return ["KNOWLEDGE CONTEXT (use only this):", ...articleLines, ...categoryLines].join("\n");
}

export function buildTurnMessages(input: {
  userUtterance: string;
  articles: MailCallArticle[];
  categories: MailCallCategory[];
  degraded?: boolean;
  usedBrandProfile?: boolean;
  brandKnowledge?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const knowledge = buildKnowledgeContextBlock(input.articles, input.categories, {
    degraded: input.degraded,
    usedBrandProfile: input.usedBrandProfile,
    brandKnowledge: input.brandKnowledge,
  });

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
  options?: { degraded?: boolean; brandSpeech?: string },
): string | null {
  if (options?.brandSpeech) return options.brandSpeech;
  if (options?.degraded) return null;
  if (articles.length === 0) {
    return "I don't have a matching story on that just yet. Could you share a topic or section you're interested in?";
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
