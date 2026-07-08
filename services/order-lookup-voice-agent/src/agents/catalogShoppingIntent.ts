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
