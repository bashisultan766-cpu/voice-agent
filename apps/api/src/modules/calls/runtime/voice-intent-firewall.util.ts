import type { UserUtteranceIntent } from './user-intent-classifier.util';
import { classifyUserIntent } from './user-intent-classifier.util';
import {
  buildProfessionalConversationReply,
  classifyConversationRouteIntent,
  sanitizeBannedVoicePhrases,
} from './professional-conversation-policy.util';

export const PRODUCT_INTENT_CONFIDENCE_THRESHOLD = 0.75;

/** Conversational/support utterances that must never trigger Shopify product search. */
export const NON_PRODUCT_SEARCH_PATTERNS: RegExp[] = [
  /\bwhat is your service\b/i,
  /\bwho are you\b/i,
  /\btell me about yourself\b/i,
  /\bwhat can you do\b/i,
  /\bcan you help me\b/i,
  /\bhow does this work\b/i,
  /\bexplain your service\b/i,
  /\bwhat are you\b/i,
  /\bwhat do you do\b/i,
  /\bhow can you help\b/i,
  /\bwhat('s| is) this (about|for)\b/i,
  /\bwhat kind of (store|business|service)\b/i,
  /\bare you (a |an )?(bot|ai|robot|real person)\b/i,
];

const COMMERCE_VERB_PATTERNS: RegExp[] = [
  /\bdo you have\b/i,
  /\bhave you got\b/i,
  /\bis .+ available\b/i,
  /\bcan i (get|order|buy)\b/i,
  /\bi need\b/i,
  /\bi want\b/i,
  /\blooking for\b/i,
  /\bsearch(ing)? for\b/i,
  /\bfind\b/i,
  /\bprice of\b/i,
  /\bhow much is\b/i,
  /\bhow much does\b/i,
  /\bbuy\b/i,
];

const OPENAI_REQUIRED_PATTERNS: RegExp[] = [
  /\b(recommend|suggest|similar to|compare|which is better|objection|too expensive|not sure if)\b/i,
  /\b(why should i|convince me|tell me more about the story)\b/i,
];

const CONVERSATIONAL_SUPPORT_INTENTS: UserUtteranceIntent[] = [
  'store_identity_question',
  'capability_question',
  'general_business_question',
];

export type IntentFirewallBlockPayload = {
  originalSpeech: string;
  blockedReason: string;
  matchedPattern: string | null;
  confidence: number;
  reroutedBrain: 'conversational_support' | 'openai_fallback';
};

export type ProductSearchGateInput = {
  text: string;
  intent?: UserUtteranceIntent;
  orderState?: string;
  hasDiscussedProduct?: boolean;
};

export type ProductSearchGateResult = {
  allowProductSearch: boolean;
  confidence: number;
  blockedReason: string | null;
  matchedPattern: string | null;
};

export function matchNonProductSearchPattern(text: string): {
  matched: boolean;
  matchedPattern: string | null;
} {
  for (const re of NON_PRODUCT_SEARCH_PATTERNS) {
    if (re.test(text)) {
      return { matched: true, matchedPattern: re.source };
    }
  }
  return { matched: false, matchedPattern: null };
}

export function hasCommerceVerb(text: string): boolean {
  return COMMERCE_VERB_PATTERNS.some((re) => re.test(text));
}

function extractProductEntity(text: string): string {
  const raw = text.trim();
  const patterns: RegExp[] = [
    /\bdo you have (.+?)[?.!]*$/i,
    /\bhave you got (.+?)[?.!]*$/i,
    /\bis (.+?) available[?.!]*$/i,
    /\bi need (.+?)[?.!]*$/i,
    /\bi want (.+?)[?.!]*$/i,
    /\blooking for (.+?)[?.!]*$/i,
    /\bcan i get (.+?)[?.!]*$/i,
    /\bcan i order (.+?)[?.!]*$/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m?.[1]?.trim()) {
      return m[1].trim().replace(/\b(please|thanks|thank you)\b/gi, '').trim();
    }
  }
  return raw
    .replace(/^(do you have|have you got|i need|i want|looking for|can i get|can i order)\s+/i, '')
    .replace(/[?.!]+$/g, '')
    .trim();
}

/** True when utterance carries an explicit book title, ISBN, or commerce + catalog signal. */
export function detectBookTitleOrCommerceSignal(text: string, hasDiscussedProduct = false): boolean {
  const raw = text.trim();
  if (!raw) return false;

  if (/\b(find|search)\s+(a\s+)?book\b/i.test(raw)) return true;
  if (/\b\d{10,13}\b/.test(raw)) return true;

  const extracted = extractProductEntity(raw);
  const extractedWords = extracted.split(/\s+/).filter(Boolean);
  if (extractedWords.length >= 2) {
    const genericOnly = /^(a|an|the|some|any|book|books)$/i;
    if (extractedWords.some((w) => !genericOnly.test(w))) return true;
  }

  if (hasCommerceVerb(raw)) {
    const remainder = extracted.trim();
    if (remainder.length >= 3 && !matchNonProductSearchPattern(remainder).matched) {
      const words = remainder.split(/\s+/).filter(Boolean);
      if (words.length >= 1 && !/^(help|service|yourself|store)$/i.test(words[0]!)) {
        return true;
      }
    }
  }

  if (
    /\b(history|mystery|romance|fiction|religion|biography|paperback|hardcover)\s+book\b/i.test(raw)
  ) {
    return true;
  }

  if (hasDiscussedProduct && /\b(price|cost|how much|available|in stock|stock)\b/i.test(raw)) {
    return true;
  }

  return false;
}

export function computeProductIntentConfidence(
  text: string,
  intent: UserUtteranceIntent,
  hasDiscussedProduct = false,
): number {
  const t = text.trim();
  if (!t) return 0;

  if (matchNonProductSearchPattern(t).matched) return 0;
  if (CONVERSATIONAL_SUPPORT_INTENTS.includes(intent)) return 0;
  if (intent === 'greeting' || intent === 'small_talk' || intent === 'store_policy_question') {
    return 0;
  }

  let confidence = 0;

  if (intent === 'product_search') confidence = 0.45;
  if (intent === 'product_question') confidence = 0.55;
  if (intent === 'purchase_confirmation') confidence = 0.4;

  if (hasCommerceVerb(t)) confidence += 0.35;
  if (detectBookTitleOrCommerceSignal(t, hasDiscussedProduct)) confidence += 0.35;
  if (hasDiscussedProduct && intent === 'product_question') confidence += 0.15;

  const words = t.split(/\s+/).filter(Boolean);
  if (
    words.length >= 5 &&
    !hasCommerceVerb(t) &&
    !detectBookTitleOrCommerceSignal(t, hasDiscussedProduct)
  ) {
    confidence = Math.min(confidence, 0.25);
  }

  return Math.min(1, Math.max(0, confidence));
}

/** Legacy fast-path eligibility (pre-firewall) — used only for block logging. */
export function wouldLegacyProductFastPath(input: ProductSearchGateInput): boolean {
  const text = input.text.trim();
  if (!text) return false;
  const intent = input.intent ?? classifyUserIntent(text);
  const orderState = (input.orderState ?? 'IDLE').trim() || 'IDLE';

  if (OPENAI_REQUIRED_PATTERNS.some((re) => re.test(text))) return false;
  if (intent === 'product_search') return true;

  if (intent === 'product_question') {
    return (
      /\b(price|cost|how much|available|in stock|stock)\b/i.test(text) ||
      Boolean(input.hasDiscussedProduct)
    );
  }

  if (intent === 'purchase_confirmation' && orderState === 'IDLE') {
    return COMMERCE_VERB_PATTERNS.some((re) => re.test(text));
  }

  if (/\b(one|two|three|\d+)\s+cop(y|ies)\b/i.test(text) && orderState !== 'IDLE') {
    return false;
  }

  return hasCommerceVerb(text) && intent !== 'store_policy_question';
}

export function evaluateProductSearchGate(input: ProductSearchGateInput): ProductSearchGateResult {
  const text = input.text.trim();
  if (!text) {
    return { allowProductSearch: false, confidence: 0, blockedReason: 'empty', matchedPattern: null };
  }

  const block = matchNonProductSearchPattern(text);
  if (block.matched) {
    return {
      allowProductSearch: false,
      confidence: 0,
      blockedReason: 'non_product_search_pattern',
      matchedPattern: block.matchedPattern,
    };
  }

  if (OPENAI_REQUIRED_PATTERNS.some((re) => re.test(text))) {
    return {
      allowProductSearch: false,
      confidence: 0,
      blockedReason: 'openai_required',
      matchedPattern: null,
    };
  }

  const intent = input.intent ?? classifyUserIntent(text);
  const orderState = (input.orderState ?? 'IDLE').trim() || 'IDLE';
  const confidence = computeProductIntentConfidence(text, intent, input.hasDiscussedProduct);

  if (confidence < PRODUCT_INTENT_CONFIDENCE_THRESHOLD) {
    return {
      allowProductSearch: false,
      confidence,
      blockedReason: 'confidence_below_threshold',
      matchedPattern: null,
    };
  }

  const hasSignal = detectBookTitleOrCommerceSignal(text, input.hasDiscussedProduct);
  if (!hasSignal) {
    return {
      allowProductSearch: false,
      confidence,
      blockedReason: 'missing_commerce_or_title_signal',
      matchedPattern: null,
    };
  }

  if (intent === 'product_question') {
    const priceStock =
      /\b(price|cost|how much|available|in stock|stock)\b/i.test(text) ||
      Boolean(input.hasDiscussedProduct);
    if (!priceStock) {
      return {
        allowProductSearch: false,
        confidence,
        blockedReason: 'product_question_without_price_signal',
        matchedPattern: null,
      };
    }
  }

  if (intent === 'purchase_confirmation' && orderState === 'IDLE') {
    if (!hasCommerceVerb(text)) {
      return {
        allowProductSearch: false,
        confidence,
        blockedReason: 'purchase_confirmation_without_commerce_verb',
        matchedPattern: null,
      };
    }
  }

  if (/\b(one|two|three|\d+)\s+cop(y|ies)\b/i.test(text) && orderState !== 'IDLE') {
    return {
      allowProductSearch: false,
      confidence,
      blockedReason: 'checkout_quantity_turn',
      matchedPattern: null,
    };
  }

  if (intent === 'store_policy_question') {
    return {
      allowProductSearch: false,
      confidence,
      blockedReason: 'store_policy_question',
      matchedPattern: null,
    };
  }

  return { allowProductSearch: true, confidence, blockedReason: null, matchedPattern: null };
}

export function buildIntentFirewallBlockPayload(
  text: string,
  gate: ProductSearchGateResult,
  reroutedBrain: IntentFirewallBlockPayload['reroutedBrain'],
): IntentFirewallBlockPayload {
  return {
    originalSpeech: text.slice(0, 500),
    blockedReason: gate.blockedReason ?? 'unknown',
    matchedPattern: gate.matchedPattern,
    confidence: gate.confidence,
    reroutedBrain,
  };
}

export function isConversationalSupportQuery(text: string, intent: UserUtteranceIntent): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  if (matchNonProductSearchPattern(trimmed).matched) return true;
  if (CONVERSATIONAL_SUPPORT_INTENTS.includes(intent)) return true;

  if (
    intent === 'product_search' &&
    computeProductIntentConfidence(trimmed, intent) < PRODUCT_INTENT_CONFIDENCE_THRESHOLD
  ) {
    return true;
  }

  return false;
}

export function buildConversationalSupportReply(
  text: string,
  intent: UserUtteranceIntent,
  storeName = 'SureShot Books',
  agentName = 'Justin',
): string {
  const route = classifyConversationRouteIntent({
    customerText: text,
    userIntent: intent,
    orderState: 'IDLE',
    storeName,
    agentName,
  });
  const reply = buildProfessionalConversationReply(route, {
    customerText: text,
    userIntent: intent,
    orderState: 'IDLE',
    storeName,
    agentName,
  });
  const sanitized = sanitizeBannedVoicePhrases(
    reply ??
      'I can help you find books, check availability and pricing, and email a secure payment link. What would you like to do today?',
  );
  return sanitized;
}
