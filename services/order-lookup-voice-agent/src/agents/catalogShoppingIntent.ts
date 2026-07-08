/**
 * Catalog / buy-flow utterance detection — shared by intent router and tracking guards.
 */
import { extractIsbnFromSpeech } from "../utils/productSearchNormalize.js";

const CATALOG_SHOPPING_RE =
  /\b(?:title\s*(?:number|#|no\.?)|isbn\s*(?:number|#|no\.?)?|another\s+book|one\s+more\s+book|different\s+book|want\s+(?:to\s+)?(?:buy|purchase)|buy\s+(?:a\s+)?(?:book|product)|add\s+(?:it\s+)?(?:to\s+)?(?:my\s+)?cart|search\s+for\s+(?:a\s+)?book|looking\s+for\s+(?:a\s+)?book|find\s+(?:me\s+)?(?:a\s+)?book|book\s+(?:called|titled|named)|have\s+(?:the\s+)?title|got\s+(?:the\s+)?title|title\s+is|catalog\s+(?:id|number)|product\s+(?:id|number))\b/i;

/** True when the caller is shopping for books — must not route to tracking dictation. */
export function isCatalogShoppingUtterance(callerText: string): boolean {
  const text = callerText.trim();
  if (!text) return false;
  if (extractIsbnFromSpeech(text)) return true;
  if (CATALOG_SHOPPING_RE.test(text)) return true;
  // STT often hears "title number" as "id number" during catalog turns.
  if (/\bid\s*number\b/i.test(text) && /\b(book|title|isbn|another|catalog|product|copy|copies|cart)\b/i.test(text)) {
    return true;
  }
  return false;
}
