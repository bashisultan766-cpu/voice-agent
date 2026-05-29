import type { LlmAgentConversationState } from '../../calls/runtime/llm-agent-conversation-state.util';

const AFFIRMATION_RE =
  /\b(yes|yeah|yep|sure|ok|okay|that one|this one|the first one|first one|second one|i'?ll take (it|that)|sounds good)\b/i;

const ORDINAL_MAP: Record<string, number> = {
  first: 0,
  '1st': 0,
  one: 0,
  second: 1,
  '2nd': 1,
  two: 1,
  third: 2,
  '3rd': 2,
  three: 2,
};

/**
 * When the caller affirms a prior recommendation ("yes that one"), reuse the last search title
 * instead of searching Shopify for the phrase "yes that one".
 */
export function resolveVoiceSearchQueryFromMemory(
  toolQuery: string,
  llmState?: LlmAgentConversationState | null,
): { effectiveQuery: string; memoryHit: boolean } {
  const q = `${toolQuery ?? ''}`.trim();
  if (!q || !llmState?.lastSearchedProducts?.length) {
    return { effectiveQuery: q, memoryHit: false };
  }
  if (!AFFIRMATION_RE.test(q)) {
    return { effectiveQuery: q, memoryHit: false };
  }

  const lower = q.toLowerCase();
  let index = 0;
  for (const [word, idx] of Object.entries(ORDINAL_MAP)) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) {
      index = idx;
      break;
    }
  }

  const pick = llmState.lastSearchedProducts[index] ?? llmState.lastSearchedProducts[0];
  if (!pick?.title?.trim()) return { effectiveQuery: q, memoryHit: false };
  return { effectiveQuery: pick.title.trim(), memoryHit: true };
}
