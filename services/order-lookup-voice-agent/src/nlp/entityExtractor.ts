/**
 * Intent router and slot extractors for Shoshan voice fulfillment.
 *
 * Handles noisy Twilio STT transcripts: spoken digits, letter/digit confusions
 * (O→0, A→8, stray S tokens), and context-aware intent classification.
 */
import {
  extractIsbnFromSpeech,
  isValidIsbnFormat,
  normalizeIsbn,
} from "../utils/productSearchNormalize.js";
import {
  isValidOrderNumberFormat,
  normalizeOrderNumber,
} from "../utils/formatter.js";

/** Primary fulfillment intents routed by the voice agent. */
export type FulfillmentIntent = "order_status" | "title_search" | "isbn_search" | "unknown";

/** Slot type extracted from caller speech. */
export type FulfillmentSlotType = "order_number" | "title" | "isbn" | "none";

export interface EntityExtractionContext {
  /** When set, bias extraction toward this slot (e.g. awaiting order number). */
  awaitingSlot?: FulfillmentSlotType;
  /** Prior partial ISBN digits from a multi-turn read. */
  isbnDraft?: string;
}

export interface EntityExtractionResult {
  intent: FulfillmentIntent;
  slotType: FulfillmentSlotType;
  orderNumber?: string;
  title?: string;
  isbn?: string;
  confidence: number;
  /** Normalized raw value used for the primary slot (debug / telemetry). */
  normalizedValue?: string;
}

/** Spoken number words → digits (phone STT). */
const SPOKEN_DIGIT_WORDS: Record<string, string> = {
  zero: "0",
  oh: "0",
  o: "0",
  one: "1",
  won: "1",
  two: "2",
  to: "2",
  too: "2",
  three: "3",
  tree: "3",
  four: "4",
  for: "4",
  fore: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  ate: "8",
  a: "8",
  nine: "9",
};

/**
 * Letters that STT often mis-hears as digits in numeric sequences.
 * Stray consonants (e.g. "S" between "four" and "five") are dropped.
 */
const LETTER_DIGIT_CONFUSIONS: Record<string, string> = {
  o: "0",
  i: "1",
  l: "1",
  z: "2",
  a: "8",
  b: "8",
  g: "8",
  f: "5",
};

const ISBN_CONTEXT_RE =
  /\b(isbn|i\s*s\s*b\s*n|barcode|978|979|97\s*8|97\s*9)\b/i;
const ORDER_CONTEXT_RE =
  /\b(order|tracking|track|status|shipment|shipped|delivery|where\s+is\s+my|order\s+number|my\s+order)\b/i;
const TITLE_CONTEXT_RE =
  /\b(book|title|author|looking\s+for|do\s+you\s+have|search\s+for|find\s+the)\b/i;
const ORDER_NUMBER_INLINE_RE = /\b#?\d{4,10}\b/;
const ISBN_COMPACT_RE = /\b97[89]\d{9}[\dXx]\b|\b\d{9}[\dXx]\b/;
const VAGUE_TITLE_RE =
  /^(i\s+)?(need|want|looking\s+for)\s+(a\s+)?(book|books|magazine|magazines)?\.?$/i;

const MULTI_INTENT_ORDER_RE =
  /\b(order\s+status|check\s+my\s+order|track(ing)?\s+(my\s+)?order|where\s+is\s+my\s+order)\b/i;
const MULTI_INTENT_PRODUCT_RE =
  /\b((and\s+)?then\s+)?(i\s+want\s+to\s+)?(buy|purchase|look\s+for\s+(a\s+)?book|search\s+for\s+(a\s+)?book|get\s+(a\s+)?book)\b/i;

/** Agenda items for multi-intent dialogue sequencing. */
export type DialogueAgendaItem = "order_status" | "product_search";

export type ShopifyGateBlockReason =
  | "missing_order_number"
  | "missing_isbn"
  | "missing_title"
  | "vague_title";

export interface ShopifyExecutionGate {
  allowed: boolean;
  reason?: ShopifyGateBlockReason;
  clarificationText: string;
}

export const CLARIFICATION_BY_REASON: Record<ShopifyGateBlockReason, string> = {
  missing_order_number: "Could you please provide your order number?",
  missing_isbn:
    "Could you please read the 10 or 13 digit ISBN from the back of the book?",
  missing_title: "What is the title of the book you're looking for?",
  vague_title: "Could you tell me the specific title of the book?",
};

function isVagueTitleCandidate(title: string): boolean {
  const t = title.trim();
  return !t || t.length < 3 || VAGUE_TITLE_RE.test(t);
}

/**
 * Collapse spoken or spaced digits into a continuous numeric string.
 * Example: "one two three four S five" → "12345"
 */
export function normalizeSpokenNumericSequence(text: string): string {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s#]/gi, " ")
    .split(/\s+/)
    .filter(Boolean);

  let out = "";
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      out += token;
      continue;
    }

    const spoken = SPOKEN_DIGIT_WORDS[token];
    if (spoken !== undefined) {
      out += spoken;
      continue;
    }

    // Single-letter STT noise or homophone in numeric context.
    if (token.length === 1) {
      const mapped = LETTER_DIGIT_CONFUSIONS[token];
      if (mapped) {
        out += mapped;
      }
      // Unmapped single letters (e.g. stray "s") are dropped — see QA test case.
      continue;
    }
  }

  return out;
}

/**
 * Normalize alphanumeric order IDs from STT.
 * Preserves letters after homophone correction; maps O→0, I→1, A→8 inside digit runs.
 */
export function normalizeAlphanumericOrderId(text: string): string {
  const spokenDigits = normalizeSpokenNumericSequence(text);
  if (spokenDigits.length >= 4) {
    return spokenDigits.startsWith("#") ? spokenDigits : `#${spokenDigits.replace(/^#/, "")}`;
  }

  const compact = text
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9#]/g, "");

  if (!compact) return "";

  let normalized = "";
  for (const ch of compact) {
    if (/\d/.test(ch)) {
      normalized += ch;
      continue;
    }
    const lower = ch.toLowerCase();
    const asDigit = LETTER_DIGIT_CONFUSIONS[lower];
    if (asDigit) {
      normalized += asDigit;
      continue;
    }
    if (/[A-Z]/.test(ch)) {
      normalized += ch;
    }
  }

  if (!normalized) return "";
  return normalized.startsWith("#") ? normalized : `#${normalized.replace(/^#/, "")}`;
}

/** Strict numeric ISBN normalization — digits and X check digit only. */
export function normalizeIsbnFromStt(text: string): string {
  const spoken = normalizeSpokenNumericSequence(text);
  const packed = text.replace(/[\s-]/g, "").toUpperCase();
  const candidate = spoken.length >= 10 ? spoken : packed.replace(/[^0-9X]/gi, "");
  return normalizeIsbn(candidate);
}

export interface OrderNumberExtractOptions {
  /** When true, allow bare spoken digits (multi-turn slot collection). */
  awaitingSlot?: boolean;
}

/**
 * Extract a Shopify order number from voice transcript.
 * Strict by default: bare digit runs are only accepted with order context
 * or when explicitly awaiting the order_number slot (prevents hallucination).
 */
export function extractOrderNumberFromStt(
  text: string,
  options: OrderNumberExtractOptions = {},
): string | null {
  const hasOrderContext = ORDER_CONTEXT_RE.test(text);
  const allowLoose = Boolean(options.awaitingSlot);

  const labeled = text.match(
    /(?:order\s*(?:number|#)?|number)\s*#?\s*([A-Za-z0-9]{4,12})/i,
  );
  if (labeled?.[1]) {
    const normalized = normalizeAlphanumericOrderId(labeled[1]);
    if (isValidOrderNumberFormat(normalized)) return normalized;
  }

  if (hasOrderContext || allowLoose) {
    const inline = text.match(/\b#?(\d{4,10})\b/);
    if (inline?.[1]) {
      const candidate = normalizeOrderNumber(`#${inline[1]}`);
      if (isValidOrderNumberFormat(candidate)) return candidate;
    }
  }

  if (allowLoose) {
    const spoken = normalizeSpokenNumericSequence(text);
    if (spoken.length >= 4 && spoken.length <= 10) {
      const candidate = normalizeOrderNumber(`#${spoken}`);
      if (isValidOrderNumberFormat(candidate)) return candidate;
    }

    const alnum = normalizeAlphanumericOrderId(text);
    if (alnum && isValidOrderNumberFormat(alnum)) return alnum;
  }

  return null;
}

/** Extract book title when caller describes a title search. */
export function extractTitleFromStt(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const patterns = [
    /(?:looking\s+for|search(?:ing)?\s+for|find(?:\s+the)?|do\s+you\s+have)\s+(?:the\s+book\s+)?(.+)/i,
    /(?:book\s+(?:called|titled|named))\s+(.+)/i,
    /(?:title\s+is)\s+(.+)/i,
  ];

  for (const re of patterns) {
    const match = trimmed.match(re);
    if (match?.[1]) {
      const title = match[1].replace(/\?+$/, "").trim();
      if (!isVagueTitleCandidate(title)) return title;
    }
  }

  if (TITLE_CONTEXT_RE.test(trimmed)) {
    const stripped = trimmed
      .replace(TITLE_CONTEXT_RE, "")
      .replace(/\b(please|thanks|thank\s+you)\b/gi, "")
      .trim();
    if (!isVagueTitleCandidate(stripped)) return stripped;
  }

  // Bare title utterance when no order/ISBN signals.
  if (
    !ORDER_CONTEXT_RE.test(trimmed) &&
    !ISBN_CONTEXT_RE.test(trimmed) &&
    !ORDER_NUMBER_INLINE_RE.test(trimmed) &&
    !ISBN_COMPACT_RE.test(trimmed) &&
    trimmed.split(/\s+/).length >= 2
  ) {
    return trimmed;
  }

  return null;
}

/** Extract and validate ISBN from STT (delegates to shared ISBN pipeline). */
export function extractIsbnFromStt(text: string, priorDraft = ""): string | null {
  const normalized = normalizeIsbnFromStt(text);
  if (normalized.length >= 10 && isValidIsbnFormat(normalized)) {
    return normalized;
  }

  const fromSpeech = extractIsbnFromSpeech(text);
  if (fromSpeech) return fromSpeech;

  if (priorDraft) {
    const combined = `${priorDraft}${normalizeSpokenNumericSequence(text)}`;
    const candidate = normalizeIsbn(combined);
    if (isValidIsbnFormat(candidate)) return candidate;
  }

  return null;
}

function classifyIntent(text: string): FulfillmentIntent {
  if (ISBN_CONTEXT_RE.test(text) || ISBN_COMPACT_RE.test(text)) {
    return "isbn_search";
  }
  if (ORDER_CONTEXT_RE.test(text)) {
    return "order_status";
  }
  if (TITLE_CONTEXT_RE.test(text)) {
    return "title_search";
  }
  return "unknown";
}

/** Detect multiple caller intents for agenda-based dialogue (order then product, etc.). */
export function detectMultiIntentAgenda(text: string): DialogueAgendaItem[] {
  const agenda: DialogueAgendaItem[] = [];
  const trimmed = (text ?? "").trim();
  if (!trimmed) return agenda;

  const wantsOrder =
    MULTI_INTENT_ORDER_RE.test(trimmed) || ORDER_CONTEXT_RE.test(trimmed);
  const wantsProduct =
    MULTI_INTENT_PRODUCT_RE.test(trimmed) ||
    (wantsOrder &&
      /\b(and\s+then|then\s+i|also\s+want\s+to)\b/i.test(trimmed) &&
      /\b(book|buy|purchase|isbn|title)\b/i.test(trimmed));

  if (wantsOrder) agenda.push("order_status");
  if (wantsProduct) agenda.push("product_search");
  return agenda;
}

/**
 * Block Shopify API calls unless a valid slot was explicitly extracted from STT.
 */
export function validateShopifyExecutionGate(
  intent: FulfillmentIntent,
  extraction: EntityExtractionResult,
): ShopifyExecutionGate {
  switch (intent) {
    case "order_status":
      if (!extraction.orderNumber) {
        return {
          allowed: false,
          reason: "missing_order_number",
          clarificationText: CLARIFICATION_BY_REASON.missing_order_number,
        };
      }
      break;
    case "isbn_search":
      if (!extraction.isbn) {
        return {
          allowed: false,
          reason: "missing_isbn",
          clarificationText: CLARIFICATION_BY_REASON.missing_isbn,
        };
      }
      break;
    case "title_search":
      if (!extraction.title) {
        return {
          allowed: false,
          reason: "missing_title",
          clarificationText: CLARIFICATION_BY_REASON.missing_title,
        };
      }
      if (isVagueTitleCandidate(extraction.title)) {
        return {
          allowed: false,
          reason: "vague_title",
          clarificationText: CLARIFICATION_BY_REASON.vague_title,
        };
      }
      break;
    default:
      return {
        allowed: false,
        reason: "missing_title",
        clarificationText:
          "I can help with order status, book titles, or ISBN lookups. What would you like to do?",
      };
  }
  return { allowed: true, clarificationText: "" };
}

/**
 * Route caller speech to intent + slot extraction.
 * Context (`awaitingSlot`) overrides ambiguous classification.
 */
export function extractEntities(
  speech: string,
  context: EntityExtractionContext = {},
): EntityExtractionResult {
  const text = (speech ?? "").trim();
  if (!text) {
    return { intent: "unknown", slotType: "none", confidence: 0 };
  }

  const awaiting = context.awaitingSlot;

  if (awaiting === "isbn" || awaiting === "order_number" || awaiting === "title") {
    return extractForAwaitingSlot(text, awaiting, context);
  }

  const isbn = extractIsbnFromStt(text, context.isbnDraft);
  if (isbn) {
    return {
      intent: "isbn_search",
      slotType: "isbn",
      isbn,
      confidence: 0.95,
      normalizedValue: isbn,
    };
  }

  const orderNumber = extractOrderNumberFromStt(text);
  if (orderNumber) {
    return {
      intent: "order_status",
      slotType: "order_number",
      orderNumber,
      confidence: ORDER_CONTEXT_RE.test(text) ? 0.95 : 0.7,
      normalizedValue: orderNumber,
    };
  }

  const title = extractTitleFromStt(text);
  if (title) {
    return {
      intent: "title_search",
      slotType: "title",
      title,
      confidence: TITLE_CONTEXT_RE.test(text) ? 0.9 : 0.75,
      normalizedValue: title,
    };
  }

  const intent = classifyIntent(text);
  return { intent, slotType: "none", confidence: intent === "unknown" ? 0.3 : 0.6 };
}

function extractForAwaitingSlot(
  text: string,
  slot: FulfillmentSlotType,
  context: EntityExtractionContext,
): EntityExtractionResult {
  if (slot === "isbn") {
    const isbn = extractIsbnFromStt(text, context.isbnDraft);
    if (isbn) {
      return {
        intent: "isbn_search",
        slotType: "isbn",
        isbn,
        confidence: 0.95,
        normalizedValue: isbn,
      };
    }
    return { intent: "isbn_search", slotType: "isbn", confidence: 0.4 };
  }

  if (slot === "order_number") {
    const orderNumber = extractOrderNumberFromStt(text, { awaitingSlot: true });
    if (orderNumber) {
      return {
        intent: "order_status",
        slotType: "order_number",
        orderNumber,
        confidence: 0.95,
        normalizedValue: orderNumber,
      };
    }
    return { intent: "order_status", slotType: "order_number", confidence: 0.4 };
  }

  const title = extractTitleFromStt(text) ?? text.trim();
  return {
    intent: "title_search",
    slotType: "title",
    title: title.length >= 2 ? title : undefined,
    confidence: title.length >= 2 ? 0.9 : 0.4,
    normalizedValue: title,
  };
}
