/**
 * Phase 1 slot parsing — conversation only, no Shopify calls.
 */
import { extractIsbnFromSpeech } from "../utils/productSearchNormalize.js";
import type { CallSession, ProductSearchSlots } from "../types/order.js";

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

  if (
    /\b(recommend|suggestions?|popular|what do you have|surprise me|anything good|suggest something)\b/i.test(
      speech,
    )
  ) {
    slots.wantsRecommendations = true;
  }

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
    wantsRecommendations: incoming.wantsRecommendations ?? existing?.wantsRecommendations,
  };
}

export function isPhase2Ready(
  slots: ProductSearchSlots,
  session?: Pick<CallSession, "awaitingInput">,
): boolean {
  if (slots.isbn) return true;
  if (slots.wantsRecommendations) return true;
  if (slots.title && session?.awaitingInput === "product_slot") return true;
  return false;
}

export type ProductSlotPromptKind = "isbn" | "title" | "both" | "category";

export function pickProductSlotQuestion(
  slots: ProductSearchSlots,
  kind: ProductSlotPromptKind = "both",
): string {
  if (kind === "category") {
    return pickVariedSlotPrompt(CATEGORY_PROMPTS);
  }
  if (slots.isbn && !slots.title) {
    return pickVariedSlotPrompt(ISBN_PROMPTS);
  }
  if (slots.title && !slots.isbn && kind !== "both") {
    return pickVariedSlotPrompt(TITLE_PROMPTS);
  }
  if (kind === "isbn") {
    return pickVariedSlotPrompt(ISBN_PROMPTS);
  }
  if (kind === "title") {
    return pickVariedSlotPrompt(TITLE_PROMPTS);
  }
  if (isGenericBookIntent(slots)) {
    return pickVariedSlotPrompt(BOOK_INTENT_PROMPTS);
  }
  return pickVariedSlotPrompt(BOTH_UNCLEAR_PROMPTS);
}

function isGenericBookIntent(slots: ProductSearchSlots): boolean {
  return Boolean(
    slots.category === "book" && !slots.isbn && !slots.title && !slots.wantsRecommendations,
  );
}

const CATEGORY_PROMPTS = [
  "What type are you looking for — books, magazines, or newspapers?",
  "Are you after a book, a magazine, or a newspaper?",
];

const BOOK_INTENT_PROMPTS = [
  "Sure — do you have a title or an ISBN number? Or would you like recommendations?",
  "Got it — share a title or ISBN, or I can suggest some popular books.",
  "Happy to help — do you have a title, an ISBN, or would you like recommendations?",
];

const ISBN_PROMPTS = [
  "Sure — what's the ISBN number?",
  "Please share the ISBN and I'll look it up.",
];

const TITLE_PROMPTS = [
  "Sure — what's the book title?",
  "Which title should I search for?",
];

const BOTH_UNCLEAR_PROMPTS = [
  "Do you have a book title, an ISBN number, a magazine name, or a newspaper name?",
  "I can look up a title, an ISBN, a magazine, or a newspaper — what do you have?",
  "Share a title or ISBN, or tell me if you'd like recommendations.",
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
