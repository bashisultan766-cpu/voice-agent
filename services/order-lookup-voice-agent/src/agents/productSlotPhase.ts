/**
 * Phase 1 slot parsing — conversation only, no Shopify calls.
 */
import type { CallStateAwaitingInput } from "../memory/callStateStore.js";
import { extractIsbnFromSpeech, normalizeIsbn } from "../utils/productSearchNormalize.js";
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

/** Caller declares they have a title, ISBN, or want recommendations (no value yet). */
export function detectSlotTypeChoice(
  speech: string,
): "isbn" | "title" | "recommendations" | null {
  const text = speech.trim();
  if (!text) return null;

  if (
    /\b(recommend|suggestions?|popular|what do you have|surprise me|anything good|suggest something|interested topic|topic)\b/i.test(
      text,
    )
  ) {
    return "recommendations";
  }

  if (
    /\b(i\s+have|i'?ve\s+got|got|with)\s+(an?\s+)?isbn\b/i.test(text) ||
    /\bisbn\s+number\b/i.test(text) ||
    /^(the\s+)?isbn\b/i.test(text)
  ) {
    return "isbn";
  }

  if (
    /\b(i\s+have|i'?ve\s+got|got|with)\s+(an?\s+)?title\b/i.test(text) ||
    /\bthe\s+title\b/i.test(text) ||
    /^title\b/i.test(text)
  ) {
    return "title";
  }

  return null;
}

/**
 * Parse slots from speech — ISBN/title ONLY when orchestrator is awaiting that value.
 * Never auto-extract ISBN from intent-only or declaration-only turns.
 */
export function parseProductSlotsFromSpeech(
  speech: string,
  awaiting: CallStateAwaitingInput = "none",
): ProductSearchSlots {
  const slots: ProductSearchSlots = {};
  const text = speech.trim();

  if (awaiting === "isbn") {
    const isbn = extractIsbnFromSpeech(text);
    if (isbn) slots.isbn = isbn;
  }

  if (awaiting === "title") {
    const titleCandidate = extractTitleCandidate(text);
    if (isMeaningfulTitle(titleCandidate)) {
      slots.title = titleCandidate;
    }
  }

  if (/\b(magazine|magazines)\b/i.test(text)) slots.category = "magazine";
  else if (/\b(newspaper|newspapers)\b/i.test(text)) slots.category = "newspaper";
  else if (/\b(book|books)\b/i.test(text)) slots.category = "book";

  if (detectSlotTypeChoice(text) === "recommendations") {
    slots.wantsRecommendations = true;
  }

  return slots;
}

export function mergeProductSlots(
  existing: ProductSearchSlots | undefined,
  incoming: ProductSearchSlots,
): ProductSearchSlots {
  const isbn = incoming.isbn ?? existing?.isbn;
  return {
    isbn: isbn ? normalizeIsbn(isbn) : undefined,
    title: incoming.title ?? existing?.title,
    category: incoming.category ?? existing?.category,
    wantsRecommendations: incoming.wantsRecommendations ?? existing?.wantsRecommendations,
  };
}

/** Advance awaiting state after caller declares slot type or provides a value. */
export function advanceProductAwaiting(
  wasAwaiting: CallStateAwaitingInput,
  speech: string,
  slots: Pick<ProductSearchSlots, "isbn" | "title" | "wantsRecommendations">,
  slotFlags?: { isbnCollected?: boolean; titleCollected?: boolean },
): CallStateAwaitingInput {
  if (slotFlags?.isbnCollected && slots.isbn) {
    if (wasAwaiting === "isbn") return "none";
  }
  if (slotFlags?.titleCollected && slots.title) {
    if (wasAwaiting === "title") return "none";
  }

  if (wasAwaiting === "isbn" && slots.isbn) return "none";
  if (wasAwaiting === "title" && slots.title) return "none";

  const choice = detectSlotTypeChoice(speech);

  if (wasAwaiting === "isbn_or_title") {
    if (choice === "isbn" && !slots.isbn && !slotFlags?.isbnCollected) return "isbn";
    if (choice === "title" && !slots.title && !slotFlags?.titleCollected) return "title";
    return "isbn_or_title";
  }

  if (wasAwaiting === "isbn" && !slots.isbn && !slotFlags?.isbnCollected) return "isbn";
  if (wasAwaiting === "title" && !slots.title && !slotFlags?.titleCollected) return "title";

  return wasAwaiting;
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

/** Pick prompt based on persisted awaiting state (3-step flow). */
export function pickProductSlotQuestionForAwaiting(
  awaiting: CallStateAwaitingInput,
  slots?: ProductSearchSlots,
  slotFlags?: { isbnCollected?: boolean; titleCollected?: boolean },
): string {
  if (slotFlags?.isbnCollected && slots?.isbn) {
    return pickVariedSlotPrompt(TITLE_VALUE_PROMPTS);
  }
  if (slotFlags?.titleCollected && slots?.title) {
    return pickProductSlotQuestion(slots ?? {}, "both");
  }
  if (awaiting === "isbn") {
    return pickVariedSlotPrompt(ISBN_VALUE_PROMPTS);
  }
  if (awaiting === "title") {
    return pickVariedSlotPrompt(TITLE_VALUE_PROMPTS);
  }
  if (awaiting === "isbn_or_title") {
    return pickVariedSlotPrompt(BOOK_INTENT_PROMPTS);
  }
  return pickProductSlotQuestion(slots ?? {}, "both");
}

export function pickProductSlotQuestion(
  slots: ProductSearchSlots,
  kind: ProductSlotPromptKind = "both",
): string {
  if (kind === "category") {
    return pickVariedSlotPrompt(CATEGORY_PROMPTS);
  }
  if (slots.isbn && !slots.title) {
    return pickVariedSlotPrompt(ISBN_VALUE_PROMPTS);
  }
  if (slots.title && !slots.isbn && kind !== "both") {
    return pickVariedSlotPrompt(TITLE_VALUE_PROMPTS);
  }
  if (kind === "isbn") {
    return pickVariedSlotPrompt(ISBN_VALUE_PROMPTS);
  }
  if (kind === "title") {
    return pickVariedSlotPrompt(TITLE_VALUE_PROMPTS);
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
  "Sure — do you have a book title, an ISBN number, or an interested topic you'd like me to search?",
  "I can help with that. Do you have a title, an ISBN, or would you like recommendations?",
  "Happy to help — do you have a title, an ISBN number, or a topic in mind?",
];

const ISBN_VALUE_PROMPTS = [
  "Great — please give me your ISBN number.",
  "Sure — go ahead and tell me the ISBN number.",
  "Please share the ISBN and I'll look it up in our store.",
];

const TITLE_VALUE_PROMPTS = [
  "Great — please give me the book title.",
  "Sure — what's the title of the book?",
  "Go ahead and tell me the title and I'll search our catalog.",
];

const BOTH_UNCLEAR_PROMPTS = [
  "Do you have a book title, an ISBN number, or a topic you'd like me to search?",
  "I can look up a title or ISBN — which do you have?",
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
