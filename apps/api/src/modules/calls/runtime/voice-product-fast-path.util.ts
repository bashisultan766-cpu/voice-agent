import type { ShopifyProductSummary } from '../../agents/shopify-agent.service';
import type { UserUtteranceIntent } from './user-intent-classifier.util';
import { shortenVoiceReply, VOICE_WORD_LIMITS } from './instant-reply.util';
import { extractProductSearchQuery } from './voice-product-query.util';

export { extractProductSearchQuery } from './voice-product-query.util';
import {
  buildIntentFirewallBlockPayload,
  evaluateProductSearchGate,
  isConversationalSupportQuery,
  type IntentFirewallBlockPayload,
  wouldLegacyProductFastPath,
} from './voice-intent-firewall.util';

export const PRODUCT_FAST_PATH_SLA_MS = 1200;
export const PRODUCT_FAST_PATH_ACK_SLA_MS = 300;
export const PRODUCT_FAST_PATH_LOCAL_SLA_MS = 900;
export const PRODUCT_FAST_PATH_SKIP_SHOPIFY_MIN = 0.7;

export type ProductFastPathDetectInput = {
  text: string;
  intent?: UserUtteranceIntent;
  orderState?: string;
  hasDiscussedProduct?: boolean;
};

export type ShouldBypassOpenAiForVoiceTurnInput = {
  text: string;
  intent: UserUtteranceIntent;
  orderState?: string;
  transactionalCheckoutState?: string | null;
  checkoutLockActive?: boolean;
  spellingCaptureActive?: boolean;
  hasDiscussedProduct?: boolean;
};

export type ShouldBypassOpenAiForVoiceTurnResult = {
  bypassOpenAI: boolean;
  useProductFastPath: boolean;
  useConversationalSupport?: boolean;
  openaiSkippedReason: string | null;
  firewallBlock?: IntentFirewallBlockPayload | null;
};

export function isProductFastPathQuery(input: ProductFastPathDetectInput): boolean {
  return evaluateProductSearchGate(input).allowProductSearch;
}

export function shouldSkipNormalizationForProductFastPath(
  text: string,
  transcriptConfidence?: string | number | null,
): boolean {
  const t = text.trim();
  if (t.length >= 80) return false;
  if (typeof transcriptConfidence === 'number' && transcriptConfidence < 0.85) return false;
  if (transcriptConfidence === 'low' || transcriptConfidence === 'uncertain') return false;
  return isProductFastPathQuery({ text: t });
}

export function buildDeterministicProductReply(args: {
  products: ShopifyProductSummary[];
  topScore?: number | null;
  discussedTitle?: string | null;
  priceOnly?: boolean;
}): string {
  const maxWords = VOICE_WORD_LIMITS.productResult;

  if (args.priceOnly && args.discussedTitle) {
    const match = args.products.find(
      (p) => p.title.toLowerCase() === args.discussedTitle!.toLowerCase(),
    );
    const price = match?.variants?.[0]?.price ?? args.products[0]?.variants?.[0]?.price;
    if (price) {
      return shortenVoiceReply(
        `Yes, I found ${args.discussedTitle}. The price is ${price}.`,
        maxWords,
      );
    }
  }

  if (!args.products.length) {
    return shortenVoiceReply(
      "I couldn't find the exact title. I can check similar books.",
      maxWords,
    );
  }

  const top = args.products[0]!;
  const second = args.products[1];
  const topScore = args.topScore ?? top.relevanceScore ?? 0;
  const secondScore = second?.relevanceScore ?? 0;

  if (
    args.products.length >= 2 &&
    second &&
    secondScore >= topScore * 0.85 &&
    topScore >= 600
  ) {
    return shortenVoiceReply(
      `I found a few similar books. The closest is ${top.title}. Would you like that one?`,
      maxWords,
    );
  }

  const price = top.variants?.[0]?.price;
  const inStock = top.variants?.some(
    (v) => (v.inventory_quantity ?? 0) > 0 || v.availableForSale === true,
  );

  if (price) {
    return shortenVoiceReply(`Yes, I found ${top.title}. The price is ${price}.`, maxWords);
  }
  if (inStock) {
    return shortenVoiceReply(`Yes, I found ${top.title}. It is available.`, maxWords);
  }
  return shortenVoiceReply(`Yes, I found ${top.title}.`, maxWords);
}

export function shouldBypassOpenAIForVoiceTurn(
  input: ShouldBypassOpenAiForVoiceTurnInput,
): ShouldBypassOpenAiForVoiceTurnResult {
  const orderState = (input.orderState ?? 'IDLE').trim() || 'IDLE';

  if (input.spellingCaptureActive) {
    return { bypassOpenAI: false, useProductFastPath: false, openaiSkippedReason: null };
  }

  if (input.checkoutLockActive || (input.transactionalCheckoutState && input.transactionalCheckoutState !== 'INACTIVE')) {
    return {
      bypassOpenAI: true,
      useProductFastPath: false,
      openaiSkippedReason: 'transactional_checkout_state',
    };
  }

  const gateInput = {
    text: input.text,
    intent: input.intent,
    orderState,
    hasDiscussedProduct: input.hasDiscussedProduct,
  };

  if (isConversationalSupportQuery(input.text, input.intent)) {
    const legacyWouldFastPath = wouldLegacyProductFastPath(gateInput);
    const gate = evaluateProductSearchGate(gateInput);
    return {
      bypassOpenAI: true,
      useProductFastPath: false,
      useConversationalSupport: true,
      openaiSkippedReason: 'conversational_support',
      firewallBlock: legacyWouldFastPath
        ? buildIntentFirewallBlockPayload(input.text, gate, 'conversational_support')
        : null,
    };
  }

  const gate = evaluateProductSearchGate(gateInput);
  if (gate.allowProductSearch) {
    return {
      bypassOpenAI: true,
      useProductFastPath: true,
      openaiSkippedReason: 'deterministic_product_fast_path',
    };
  }

  if (wouldLegacyProductFastPath(gateInput)) {
    return {
      bypassOpenAI: false,
      useProductFastPath: false,
      openaiSkippedReason: null,
      firewallBlock: buildIntentFirewallBlockPayload(input.text, gate, 'openai_fallback'),
    };
  }

  const instantIntents: UserUtteranceIntent[] = [
    'greeting',
    'small_talk',
    'email_provided',
    'purchase_confirmation',
  ];
  if (instantIntents.includes(input.intent) && orderState === 'IDLE' && input.intent !== 'purchase_confirmation') {
    return {
      bypassOpenAI: true,
      useProductFastPath: false,
      openaiSkippedReason: 'instant_deterministic_reply',
    };
  }

  return { bypassOpenAI: false, useProductFastPath: false, openaiSkippedReason: null };
}

export function normalizeProductFastPathConfidence(score: number | null | undefined): number {
  if (score == null || !Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, score / 1000));
}

export function shouldSkipShopifyForFastPath(confidence: number): boolean {
  return confidence >= PRODUCT_FAST_PATH_SKIP_SHOPIFY_MIN;
}
