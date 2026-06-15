/**
 * SureShot Books voice agent — transcript normalization and domain intent classification.
 * Used before routing ElevenLabs/Twilio speech to order lookup, refund, facility, or refusal paths.
 */

export const ORDER_RELATED_KEYWORDS = [
  'order',
  'order number',
  'tracking',
  'shipment',
  'refund',
  'payment',
  'card',
  'email',
  'facility',
  'inmate',
  'delivery',
  'status',
] as const;

export type SureShotVoiceIntent =
  | 'order_lookup'
  | 'collect_order_number'
  | 'tracking_status'
  | 'refund_status'
  | 'payment_inquiry'
  | 'facility_payment_link'
  | 'address_on_order'
  | 'address_other_customer'
  | 'medical_refusal'
  | 'general_order_support'
  | 'unknown';

export type SureShotIntentResult = {
  intent: SureShotVoiceIntent;
  transcriptRaw: string;
  transcriptNormalized: string;
  isOrderRelated: boolean;
  blocksMedicalRefusal: boolean;
  matchedKeywords: string[];
  /** Suggested backend tool or flow for the agent runtime. */
  suggestedAction: string;
};

const MEDICAL_REFUSAL_PATTERN =
  /\b(diagnos|prescription|medication dosage|symptom treatment|medical advice|doctor recommend)\b/i;

/** Higher-priority phrase → intent (checked on normalized text). */
const PHRASE_INTENTS: Array<{ pattern: RegExp; intent: SureShotVoiceIntent; action: string }> = [
  {
    pattern: /\b(what is|what's) (another|someone else'?s?|a different) customer'?s? address\b/i,
    intent: 'address_other_customer',
    action: 'refuse_third_party_address',
  },
  {
    pattern: /\b(what|which) address is (on|for) (this|my|the) order\b/i,
    intent: 'address_on_order',
    action: 'get_order_with_verification',
  },
  {
    pattern: /\b(send|email|get) (me )?(a |the )?facility (payment )?link\b/i,
    intent: 'facility_payment_link',
    action: 'create_facility_secure_link',
  },
  {
    pattern: /\b(facility|inmate|prison|jail).*(payment|pay|link)\b/i,
    intent: 'facility_payment_link',
    action: 'create_facility_secure_link',
  },
  {
    pattern: /\bwhere is my order\b/i,
    intent: 'tracking_status',
    action: 'get_order_tracking',
  },
  {
    pattern: /\b(track(ing)? (my )?order|shipment status|delivery status)\b/i,
    intent: 'tracking_status',
    action: 'get_order_tracking',
  },
  {
    pattern: /\bcard refund\b/i,
    intent: 'refund_status',
    action: 'get_order_refund',
  },
  {
    pattern: /\b(refund on my card|refund (to|on) (my )?card|card was refunded)\b/i,
    intent: 'refund_status',
    action: 'get_order_refund',
  },
  {
    pattern: /\b(refund status|was i refunded|my refund)\b/i,
    intent: 'refund_status',
    action: 'get_order_refund',
  },
  {
    pattern: /\b(order number|order #|order no)\b/i,
    intent: 'collect_order_number',
    action: 'collect_order_number',
  },
  {
    pattern: /\b(i give you the order|give you the order|here is the order number|here'?s the order)\b/i,
    intent: 'collect_order_number',
    action: 'collect_order_number',
  },
  {
    pattern: /\bmy order\b/i,
    intent: 'order_lookup',
    action: 'get_order',
  },
  {
    pattern: /\b(payment status|charged my card|payment on (my )?card)\b/i,
    intent: 'payment_inquiry',
    action: 'get_order_payment',
  },
];

/** STT mishearings → canonical tokens (order-sensitive phrases first). */
const FUZZY_PHRASE_REPLACEMENTS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bwhere is my order\b/gi, replacement: 'where is my order' },
  { pattern: /\bgive you the order\b/gi, replacement: 'give you the order' },
  { pattern: /\bmy order\b/gi, replacement: 'my order' },
  { pattern: /\bcard refund\b/gi, replacement: 'card refund' },
  { pattern: /\bordinar(?:y|ies)\b/gi, replacement: 'order' },
  { pattern: /\bordering\b/gi, replacement: 'order' },
  { pattern: /\bordered\b/gi, replacement: 'order' },
];

const ORDER_KEYWORD_PATTERNS: Record<string, RegExp> = {
  order: /\borders?\b/i,
  'order number': /\b(order numbers?|order #|order no\.?)\b/i,
  tracking: /\b(track(ing)?|tracked)\b/i,
  shipment: /\b(shipment|shipped|shipping)\b/i,
  refund: /\brefunds?\b/i,
  payment: /\bpayments?\b/i,
  card: /\b(cards?|credit card|debit card)\b/i,
  email: /\b(emails?|e-mail)\b/i,
  facility: /\bfacilit(?:y|ies)\b/i,
  inmate: /\b(inmates?|incarcerat(?:ed|ion))\b/i,
  delivery: /\bdeliver(?:y|ies|ed)\b/i,
  status: /\bstatus\b/i,
};

function normWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Apply fuzzy STT corrections before keyword and phrase matching. */
export function normalizeTranscriptText(raw: string): string {
  let t = normWhitespace(raw.toLowerCase());
  for (const { pattern, replacement } of FUZZY_PHRASE_REPLACEMENTS) {
    t = t.replace(pattern, replacement);
  }
  return t;
}

export function containsOrderSignal(normalized: string): boolean {
  return /\borders?\b/i.test(normalized);
}

export function matchOrderKeywords(normalized: string): string[] {
  const matched: string[] = [];
  for (const [keyword, pattern] of Object.entries(ORDER_KEYWORD_PATTERNS)) {
    if (pattern.test(normalized)) matched.push(keyword);
  }
  return matched;
}

export function isOrderRelatedTranscript(normalized: string): boolean {
  return matchOrderKeywords(normalized).length > 0;
}

function classifyByPhrases(normalized: string): SureShotIntentResult | null {
  for (const { pattern, intent, action } of PHRASE_INTENTS) {
    if (pattern.test(normalized)) {
      return {
        intent,
        transcriptRaw: '',
        transcriptNormalized: normalized,
        isOrderRelated: isOrderRelatedTranscript(normalized),
        blocksMedicalRefusal: containsOrderSignal(normalized),
        matchedKeywords: matchOrderKeywords(normalized),
        suggestedAction: action,
      };
    }
  }
  return null;
}

/**
 * Classify caller intent from raw speech transcript.
 * If transcript contains "order" (after fuzzy normalization), never routes to medical_refusal.
 */
export function classifySureShotVoiceIntent(raw: string): SureShotIntentResult {
  const transcriptRaw = normWhitespace(raw);
  const transcriptNormalized = normalizeTranscriptText(transcriptRaw);
  const matchedKeywords = matchOrderKeywords(transcriptNormalized);
  const isOrderRelated = matchedKeywords.length > 0;
  const blocksMedicalRefusal = containsOrderSignal(transcriptNormalized);

  const phraseMatch = classifyByPhrases(transcriptNormalized);
  if (phraseMatch) {
    return { ...phraseMatch, transcriptRaw, transcriptNormalized };
  }

  if (MEDICAL_REFUSAL_PATTERN.test(transcriptNormalized) && !blocksMedicalRefusal) {
    return {
      intent: 'medical_refusal',
      transcriptRaw,
      transcriptNormalized,
      isOrderRelated,
      blocksMedicalRefusal,
      matchedKeywords,
      suggestedAction: 'refuse_medical_topic',
    };
  }

  if (isOrderRelated) {
    const intent: SureShotVoiceIntent = matchedKeywords.includes('refund')
      ? 'refund_status'
      : matchedKeywords.includes('tracking') ||
          matchedKeywords.includes('shipment') ||
          matchedKeywords.includes('delivery')
        ? 'tracking_status'
        : 'general_order_support';

    return {
      intent,
      transcriptRaw,
      transcriptNormalized,
      isOrderRelated,
      blocksMedicalRefusal,
      matchedKeywords,
      suggestedAction:
        intent === 'refund_status'
          ? 'get_order_refund'
          : intent === 'tracking_status'
            ? 'get_order_tracking'
            : 'get_order',
    };
  }

  return {
    intent: 'unknown',
    transcriptRaw,
    transcriptNormalized,
    isOrderRelated: false,
    blocksMedicalRefusal: false,
    matchedKeywords: [],
    suggestedAction: 'continue_conversation',
  };
}
