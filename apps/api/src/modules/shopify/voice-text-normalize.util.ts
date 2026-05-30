/**
 * Voice search text normalization — accents, punctuation, unicode, whitespace.
 */

/** Lowercase, NFKD, strip diacritics, trim punctuation, collapse whitespace. */
export function normalizeVoiceText(raw: string): string {
  let s = `${raw ?? ''}`.normalize('NFKD');
  s = s.replace(/\p{M}/gu, '');
  s = s.toLowerCase();
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Stable cache key segment from a voice query. */
export function normalizeVoiceCacheKey(raw: string): string {
  return normalizeVoiceText(raw);
}

export function tokenizeNormalized(text: string): string[] {
  const n = normalizeVoiceText(text);
  if (!n) return [];
  return n.split(' ').filter((t) => t.length > 0);
}

/**
 * Optional typo-tolerant query variants for Shopify fetch + token matching.
 * e.g. "Atomic Habits" → "Atomic Habit", "Atomc Habits"
 */
export function generateTypoQueryVariants(rawQuery: string, maxVariants = 2): string[] {
  const base = rawQuery.trim();
  if (!base) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  const push = (q: string) => {
    const t = q.trim();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push(t);
  };

  push(base);

  const tokens = base.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    if (last.length > 4 && /s$/i.test(last)) {
      const singular = last.replace(/s$/i, '');
      push([...tokens.slice(0, -1), singular].join(' '));
    }
  }

  if (tokens.length > 0) {
    let longestIdx = 0;
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i].length > tokens[longestIdx].length) longestIdx = i;
    }
    const word = tokens[longestIdx];
    if (word.length >= 5) {
      const dropIdx = Math.floor(word.length / 2);
      const typoWord = word.slice(0, dropIdx) + word.slice(dropIdx + 1);
      const typoTokens = [...tokens];
      typoTokens[longestIdx] = typoWord;
      push(typoTokens.join(' '));
    }
  }

  return out.slice(0, 1 + maxVariants);
}

/** Split multilingual Shopify titles: "Hábitos Atómicos / Atomic Habits" */
export function splitMultilingualTitleFragments(title: string): string[] {
  const parts = title
    .split(/\s*\/\s*/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts : [title.trim()];
}
