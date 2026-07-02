/**
 * Phase 1 slot parsing — conversation only, no Shopify calls.
 */
import { extractIsbnFromSpeech } from "../tools/shopifyProductTools.js";
import type { ProductSearchSlots } from "../types/order.js";

const GENERIC_TITLE_RE =
  /^(a |the )?(book|books|magazine|magazines|newspaper|newspapers|something|anything)$/i;

const FILLER_STRIP_RE =
  /\b(do you have|looking for|i want|i need|any|available|books?|magazines?|newspapers?|to buy|buy|purchase)\b/gi;

export function extractTitleCandidate(speech: string): string {
  return speech
    .replace(FILLER_STRIP_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isMeaningfulTitle(title: string): boolean {
  const t = title.trim();
  if (t.length < 3) return false;
  if (GENERIC_TITLE_RE.test(t)) return false;
  if (/^(for )?inmates?$/i.test(t)) return false;
  return true;
}

export function parseProductSlotsFromSpeech(speech: string): ProductSearchSlots {
  const slots: ProductSearchSlots = {};
  const isbn = extractIsbnFromSpeech(speech);
  if (isbn) slots.isbn = isbn;

  const titleCandidate = extractTitleCandidate(speech);
  if (isMeaningfulTitle(titleCandidate)) {
    slots.title = titleCandidate;
  }

  if (/\b(magazine|magazines)\b/i.test(speech)) slots.category = "magazine";
  else if (/\b(newspaper|newspapers)\b/i.test(speech)) slots.category = "newspaper";
  else if (/\b(book|books)\b/i.test(speech)) slots.category = "book";

  return slots;
}

export function mergeProductSlots(
  existing: ProductSearchSlots | undefined,
  incoming: ProductSearchSlots,
): ProductSearchSlots {
  return {
    isbn: incoming.isbn ?? existing?.isbn,
    title: incoming.title ?? existing?.title,
    category: incoming.category ?? existing?.category,
  };
}

export function isPhase2Ready(slots: ProductSearchSlots): boolean {
  return Boolean(slots.isbn || slots.title);
}

export type ProductSlotPromptKind = "isbn" | "title" | "both" | "category";

export function pickProductSlotQuestion(
  slots: ProductSearchSlots,
  kind: ProductSlotPromptKind = "both",
): string {
  if (kind === "category") {
    return "What type are you looking for — books, magazines, or newspapers?";
  }
  if (slots.isbn && !slots.title) {
    return pickVariedSlotPrompt(ISBN_PROMPTS);
  }
  if (slots.title && !slots.isbn) {
    return pickVariedSlotPrompt(TITLE_PROMPTS);
  }
  if (kind === "isbn") {
    return pickVariedSlotPrompt(ISBN_PROMPTS);
  }
  if (kind === "title") {
    return pickVariedSlotPrompt(TITLE_PROMPTS);
  }
  return pickVariedSlotPrompt(BOTH_UNCLEAR_PROMPTS);
}

const ISBN_PROMPTS = [
  "Sure — please share the ISBN number.",
  "What's the ISBN for the book you're looking for?",
];

const TITLE_PROMPTS = [
  "Sure — what book title are you looking for?",
  "Which title should I look up for you?",
];

const BOTH_UNCLEAR_PROMPTS = [
  "Do you have an ISBN number or a book title?",
  "Do you have a title or an ISBN number?",
  "I can look it up by ISBN or title — which do you have?",
];

let promptRotation = 0;

function pickVariedSlotPrompt(options: string[]): string {
  const line = options[promptRotation % options.length];
  promptRotation += 1;
  return line;
}

/** Reset rotation for tests. */
export function resetSlotPromptRotation(): void {
  promptRotation = 0;
}
