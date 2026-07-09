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
  /\b(?:add\s+(?:\d+|[a-z-]+)\s*(?:more\s+)?cop(?:y|ies)|add\s+(?:it|this|that)(?:\s+to\s+(?:my\s+)?cart)?|make\s+it\s+\d+|change\s+(?:it\s+)?to\s+\d+|set\s+(?:it\s+)?to\s+\d+|remove\s+(?:that|this)\s+book|change\s+quantity\s+to\s+\d+|send\s+(?:me\s+)?(?:a\s+)?payment\s+link|checkout\s+now|pay\s+now)\b/i;

/** True when the caller is changing cart quantity or checkout — not order lookup or support. */
export function isCartActionUtterance(callerText: string): boolean {
  const text = callerText.trim();
  if (!text) return false;
  if (CART_ACTION_RE.test(text)) return true;
  if (/\b\d+\s+cop(?:y|ies)\b/i.test(text) && /\b(add|want|need|make)\b/i.test(text)) return true;
  return false;
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
  fifteen: 15,
  twenty: 20,
  twentyfive: 25,
  "twenty-five": 25,
};

/** Parse spoken quantity from cart commands — e.g. "add 20 copies", "make it ten". */
export function parseCartQuantityFromSpeech(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;

  const digitMatch =
    t.match(/\b(?:add|want|need|make\s+it|change\s+to|set\s+to)\s+(\d+)\b/) ??
    t.match(/\b(\d+)\s+cop(?:y|ies)\b/);
  if (digitMatch?.[1]) {
    const n = Number.parseInt(digitMatch[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  for (const [word, value] of Object.entries(SPOKEN_QTY)) {
    if (new RegExp(`\\b${word}\\s+cop(?:y|ies)\\b`).test(t) || new RegExp(`\\badd\\s+${word}\\b`).test(t)) {
      return value;
    }
    if (new RegExp(`\\bmake\\s+it\\s+${word}\\b`).test(t)) {
      return value;
    }
  }
  return null;
}
