const PHRASES = {
  checking: "Let me check that for you.",
  found_order: "I found your order.",
  closing_question: "Is there anything else I can help with on this order?",
  follow_up: "Happy to help with anything else on this order.",
  goodbye: "Thanks for calling SureShot Books. Take care.",
  one_moment: "One moment while I pull that up.",
} as const;

export type PhraseKey = keyof typeof PHRASES;

const cache = new Map<string, string>(Object.entries(PHRASES));

export function getCachedPhrase(key: PhraseKey): string {
  return cache.get(key) ?? PHRASES[key];
}

export function warmPhraseCache(): void {
  for (const [key, value] of Object.entries(PHRASES)) {
    cache.set(key, value);
  }
}

export function listCachedPhrases(): ReadonlyArray<{ key: PhraseKey; text: string }> {
  return (Object.keys(PHRASES) as PhraseKey[]).map((key) => ({
    key,
    text: getCachedPhrase(key),
  }));
}
