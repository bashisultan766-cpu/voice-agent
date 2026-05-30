/**
 * Normalizes caller speech into a clean Shopify catalog search query.
 */

const FILLER_PREFIX =
  /^(okay|ok|yes|yeah|sure|so|well|uh|um|hmm|please|thanks|thank you)[,.\s]+/i;

const GIVE_ME_BOOK =
  /\b(give me|get me|i need|i want|looking for|find|search for)\s+(?:the\s+)?(?:book[,]?\s+)?(.+)$/i;

const VAGUE_QUERY_PATTERNS: RegExp[] = [
  /^(tell me|check|so check|please check|look it up)[\s!.?]*$/i,
  /^(similar titles?|similar books?|a similar book|the similar book)[\s!.?]*$/i,
  /^i\s+(uh\s+)?give me\s+(a\s+)?similar\b/i,
  /^so[,.\s]+please\s+(check|give)\b/i,
  /^which\s+(one|1)\s+say\b/i,
  /^say\s+it\s+again\b/i,
];

/** Strip leading fillers and ASR noise for search. */
export function stripVoiceFillerPrefixes(text: string): string {
  let t = text.trim();
  for (let i = 0; i < 4; i++) {
    const next = t.replace(FILLER_PREFIX, '').trim();
    if (next === t) break;
    t = next;
  }
  return t.replace(/\s+/g, ' ').trim();
}

export function extractProductSearchQuery(text: string): string {
  const raw = stripVoiceFillerPrefixes(text);
  if (!raw) return '';

  const giveMe = raw.match(GIVE_ME_BOOK);
  if (giveMe?.[2]?.trim()) {
    return cleanTitleFragment(giveMe[2]);
  }

  const patterns: RegExp[] = [
    /\bdo you have (.+?)[?.!]*$/i,
    /\bhave you got (.+?)[?.!]*$/i,
    /\bis (.+?) available[?.!]*$/i,
    /\bi need (.+?)[?.!]*$/i,
    /\bi want (.+?)[?.!]*$/i,
    /\blooking for (.+?)[?.!]*$/i,
    /\bcan i get (.+?)[?.!]*$/i,
    /\bcan i order (.+?)[?.!]*$/i,
    /\bgive me (.+?)[?.!]*$/i,
    /\bfind (.+?)[?.!]*$/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m?.[1]?.trim()) return cleanTitleFragment(m[1]);
  }

  return cleanTitleFragment(
    raw
      .replace(/^(do you have|have you got|i need|i want|looking for|can i get|can i order|give me|find)\s+/i, '')
      .replace(/[?.!]+$/g, ''),
  );
}

function cleanTitleFragment(fragment: string): string {
  return fragment
    .trim()
    .replace(/\b(please|thanks|thank you|the book|book)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[,.\s]+|[,.\s]+$/g, '')
    .trim();
}

export function isWeakProductSearchQuery(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q || q.length < 3) return true;
  return VAGUE_QUERY_PATTERNS.some((re) => re.test(q));
}

export function requiresOpenAiProductReasoning(text: string): boolean {
  return /\b(similar|recommend|suggest|like that|alternatives?|other books?|comparable)\b/i.test(text);
}

export function isRepeatOrClarificationRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    /\b(say (it|that) again|repeat (that|it)|can you repeat|say again|which one)\b/i.test(t) ||
    /^which\s+(one|1)\s/i.test(t)
  );
}

export function isContextualAcknowledgment(text: string): boolean {
  const t = text.trim();
  return (
    /^(okay|ok|yes|sure|please|thanks)[,.\s!]*$/i.test(t) ||
    /^(okay|ok|yes|sure)[,.\s]+please[.!?\s]*$/i.test(t)
  );
}

export const PRODUCT_FAST_PATH_MIN_RESULT_CONFIDENCE = 0.6;
