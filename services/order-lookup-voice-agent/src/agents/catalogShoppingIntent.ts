/**
 * Catalog / buy-flow utterance detection — shared by intent router and tracking guards.
 */
import { extractIsbnFromSpeech } from "../utils/productSearchNormalize.js";

const CATALOG_SHOPPING_RE =
  /\b(?:title\s*(?:number|#|no\.?)|isbn\s*(?:number|#|no\.?)?|another\s+book|one\s+more\s+book|different\s+book|want\s+(?:to\s+)?(?:buy|purchase)|buy\s+(?:a\s+)?(?:book|product)|add\s+(?:it\s+)?(?:to\s+)?(?:my\s+)?cart|search\s+for\s+(?:a\s+)?book|looking\s+for\s+(?:a\s+)?book|find\s+(?:me\s+)?(?:the\s+)?(?:exact\s+)?book|book\s+(?:called|titled|named|title|store)|have\s+(?:the\s+)?title|got\s+(?:the\s+)?title|title\s+is|catalog\s+(?:id|number)|product\s+(?:id|number)|asking\s+about\s+(?:the\s+)?book|exact\s+book\s+title|rich\s+dad|poor\s+dad|book\s+whose\s+price|price\s+(?:on\s+(?:the\s+)?(?:website|store)|is|of))\b/i;

/** Parse a spoken dollar amount from catalog utterances (e.g. "9.99 dollars"). */
export function extractSpokenCatalogPrice(callerText: string): number | null {
  const text = callerText.trim();
  if (!text) return null;
  const match =
    text.match(/\$\s*(\d{1,4}(?:\.\d{1,2})?)/) ??
    text.match(/\b(\d{1,3}(?:\.\d{1,2})?)\s*(?:dollars?|bucks|usd|cents?)\b/i);
  if (!match?.[1]) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** True when the caller is shopping for books — must not route to tracking dictation. */
export function isCatalogShoppingUtterance(callerText: string): boolean {
  const text = callerText.trim();
  if (!text) return false;
  if (extractIsbnFromSpeech(text)) return true;
  if (CATALOG_SHOPPING_RE.test(text)) return true;
  if (extractSpokenCatalogPrice(text) != null && /\b(book|price|title|isbn|copy|copies)\b/i.test(text)) {
    return true;
  }
  // STT often hears "title number" as "id number" during catalog turns.
  if (/\bid\s*number\b/i.test(text) && /\b(book|title|isbn|another|catalog|product|copy|copies|cart)\b/i.test(text)) {
    return true;
  }
  return false;
}

const CART_ACTION_RE =
  /\b(?:add\s+(?:\d+|[a-z-]+)\s*(?:more\s+)?cop(?:y|ies)|add\s+(?:it|this|that)(?:\s+to\s+(?:my\s+)?cart)?|make\s+it\s+\d+|change\s+(?:it\s+)?to\s+\d+|set\s+(?:it\s+)?to\s+\d+|i\s+just\s+want\s+\d+|don'?t\s+add|do\s+not\s+add|remove\s+(?:that|this|\d+)\s*(?:book|cop(?:y|ies))?|minus\s+\d+|change\s+quantity\s+to\s+\d+|send\s+(?:me\s+)?(?:a\s+)?payment\s+link|checkout\s+now|pay\s+now)\b/i;

/** True when the caller is changing cart quantity or checkout — not order lookup or support. */
export function isCartActionUtterance(callerText: string): boolean {
  const text = callerText.trim();
  if (!text) return false;
  if (CART_ACTION_RE.test(text)) return true;
  if (/\b\d+\s+cop(?:y|ies)\b/i.test(text) && /\b(add|want|need|make|total|don'?t)\b/i.test(text)) {
    return true;
  }
  return false;
}

/**
 * Resolve add vs remove vs set_exact from natural speech.
 * Absolute/correction language wins over blind addition.
 */
export function resolveCartActionTypeFromSpeech(
  text: string,
): "add" | "remove" | "set_exact" {
  const t = text.trim().toLowerCase();
  const explicitAddMore =
    /\b(?:add|give\s+me)\s+(?:\d+|[a-z-]+)\s*(?:more|extra)\b/.test(t) ||
    /\badd\s+(?:\d+|[a-z-]+)\s+cop(?:y|ies)\b/.test(t) ||
    /\badd\s+(?:it|this|that)\b/.test(t);
  const explicitRemove =
    /\b(?:remove|minus|take\s+(?:away|off)|subtract)\s+(?:\d+|[a-z-]+)?/.test(t) &&
    !/\bmake\s+it\b/.test(t);

  const absoluteOrCorrection =
    /\b(?:make\s+it|change\s+(?:it\s+)?to|set\s+(?:it\s+)?to|i\s+just\s+want|want\s+\d+\s+total|total\s+of\s+\d+|don'?t\s+add|do\s+not\s+add|no,?\s+(?:don'?t|not)\b)/.test(
      t,
    ) || /\bnot\s+\d+[,.]?\s*(?:i\s+)?want\s+\d+\b/.test(t);

  if (absoluteOrCorrection && !explicitAddMore) return "set_exact";
  if (explicitRemove) return "remove";
  if (explicitAddMore) return "add";
  if (/\bi\s+want\s+(?:\d+|[a-z-]+)\s+cop(?:y|ies)\b/.test(t)) return "set_exact";
  return "add";
}

const SPOKEN_QTY: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  twentyfive: 25,
  "twenty-five": 25,
  thirty: 30,
  forty: 40,
  fifty: 50,
};

/**
 * Semantic Intent Resolver — map bare / natural-language quantity answers to integers.
 * Prevents Verification Over-Constraint on replies like "one", "just one", "a single copy".
 */
export function mapNaturalLanguageToInteger(input: string): number | null {
  const raw = (input ?? "").trim().toLowerCase();
  if (!raw) return null;

  // Pure digits (optionally with "x" / "#")
  const digitOnly = raw.match(/^(?:#|x)?\s*(\d{1,3})\s*$/);
  if (digitOnly?.[1]) {
    const n = Number.parseInt(digitOnly[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // Strip polite wrappers: "just one", "only 1 please", "a single copy", "one please"
  const stripped = raw
    .replace(/^(?:just|only|maybe|like|uh+|um+|please|ok(?:ay)?|alright|yes[,.]?\s*)+/g, "")
    .replace(/[,.]?\s*(?:please|thanks|thank\s+you)\s*$/g, "")
    .trim();

  const singleCopy =
    stripped.match(
      /^(?:a\s+)?(?:single|one)\s+(?:copy|copies|book|books)?$/,
    ) ?? stripped.match(/^one$/);
  if (singleCopy) return 1;

  const aCopy = /^(?:a|an)\s+(?:copy|book)$/.test(stripped);
  if (aCopy) return 1;

  const digitWrapped = stripped.match(/^(\d{1,3})(?:\s*(?:cop(?:y|ies)|books?|x))?$/);
  if (digitWrapped?.[1]) {
    const n = Number.parseInt(digitWrapped[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  for (const [word, value] of Object.entries(SPOKEN_QTY)) {
    if (
      stripped === word ||
      stripped === `${word} copy` ||
      stripped === `${word} copies` ||
      stripped === `${word} book` ||
      stripped === `${word} books`
    ) {
      return value;
    }
  }

  return null;
}

/** True when the utterance is ONLY a quantity answer (not a full cart command). */
export function isBareQuantityReply(text: string): boolean {
  return mapNaturalLanguageToInteger(text) != null && !CART_ACTION_RE.test(text.trim());
}

/** True when the last assistant turn asked how many copies (quantity Confirmation Turn). */
export function lastAssistantAskedForQuantity(
  messages: Array<{ role: string; content: string }>,
): boolean {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  if (!last?.content) return false;
  return /\bhow\s+many\s+cop(?:y|ies)\b/i.test(last.content);
}

/** Parse spoken quantity from cart commands — e.g. "add 20 copies", "make it ten", "just want 5 total", bare "one". */
export function parseCartQuantityFromSpeech(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;

  // Bare / natural-language quantity answers first (Semantic Intent Resolver).
  const bare = mapNaturalLanguageToInteger(t);
  if (bare != null && isBareQuantityReply(t)) {
    return bare;
  }

  const digitMatch =
    t.match(
      /\b(?:add|want|need|make\s+it|change\s+(?:it\s+)?to|set\s+(?:it\s+)?to|just\s+want|total(?:\s+of)?)\s+(\d+)\b/,
    ) ??
    t.match(/\b(?:don'?t\s+add(?:\s+more)?(?:,|\s+)?(?:i\s+)?(?:just\s+)?want)\s+(\d+)\b/) ??
    t.match(/\bnot\s+\d+[,.]?\s*(?:i\s+)?want\s+(\d+)\b/) ??
    t.match(/\b(\d+)\s+(?:cop(?:y|ies)|total)\b/);
  if (digitMatch?.[1]) {
    const n = Number.parseInt(digitMatch[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  for (const [word, value] of Object.entries(SPOKEN_QTY)) {
    if (new RegExp(`\\b${word}\\s+cop(?:y|ies)\\b`).test(t) || new RegExp(`\\badd\\s+${word}\\b`).test(t)) {
      return value;
    }
    if (
      new RegExp(`\\bmake\\s+it\\s+${word}\\b`).test(t) ||
      new RegExp(`\\bjust\\s+want\\s+${word}\\b`).test(t) ||
      new RegExp(`\\bjust\\s+${word}\\b`).test(t)
    ) {
      return value;
    }
  }

  // Fall through: still accept resolver for "just one" style wrappers inside longer phrases.
  return bare;
}
