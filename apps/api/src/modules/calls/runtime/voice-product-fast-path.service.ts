import { Injectable, Logger } from '@nestjs/common';
import { ShopifyAgentService } from '../../agents/shopify-agent.service';
import { CallMemoryService } from './call-memory.service';
import type { UserUtteranceIntent } from './user-intent-classifier.util';
import {
  buildDeterministicProductReply,
  extractProductSearchQuery,
  isProductFastPathQuery,
  normalizeProductFastPathConfidence,
  PRODUCT_FAST_PATH_LOCAL_SLA_MS,
  PRODUCT_FAST_PATH_SLA_MS,
  shouldSkipShopifyForFastPath,
} from './voice-product-fast-path.util';
import {
  buildIntentFirewallBlockPayload,
  evaluateProductSearchGate,
  isConversationalSupportQuery,
  wouldLegacyProductFastPath,
} from './voice-intent-firewall.util';

export type ProductFastPathExecuteInput = {
  callSessionId: string;
  tenantId: string;
  agentId: string;
  speechText: string;
  intent: UserUtteranceIntent;
  orderState?: string;
  sessionMeta?: Record<string, unknown>;
};

export type ProductFastPathExecuteResult = {
  used: boolean;
  reply?: string;
  localProductSearchMs?: number;
  shopifySkipped?: boolean;
  productFastPathConfidence?: number;
  openaiCalled: false;
  product_fast_path_used: boolean;
  brain: 'deterministic_product_fast_path';
};

@Injectable()
export class VoiceProductFastPathService {
  private readonly logger = new Logger(VoiceProductFastPathService.name);

  constructor(
    private readonly shopifyAgent: ShopifyAgentService,
    private readonly callMemory: CallMemoryService,
  ) {}

  async execute(input: ProductFastPathExecuteInput): Promise<ProductFastPathExecuteResult> {
    const miss: ProductFastPathExecuteResult = {
      used: false,
      openaiCalled: false,
      product_fast_path_used: false,
      brain: 'deterministic_product_fast_path',
    };

    const memory = await this.callMemory.load(input.callSessionId);
    const discussed = memory.discussedProducts ?? memory.mentionedProducts ?? [];
    const hasDiscussedProduct = discussed.length > 0;
    const discussedTitle = discussed[discussed.length - 1]?.title ?? null;

    const gateInput = {
      text: input.speechText,
      intent: input.intent,
      orderState: input.orderState,
      hasDiscussedProduct,
    };

    if (
      !isProductFastPathQuery({
        text: input.speechText,
        intent: input.intent,
        orderState: input.orderState,
        hasDiscussedProduct,
      })
    ) {
      if (wouldLegacyProductFastPath(gateInput)) {
        const gate = evaluateProductSearchGate(gateInput);
        this.logger.warn(
          JSON.stringify({
            event: 'voice.intent.firewall.blocked_product_search',
            callSessionId: input.callSessionId,
            tenantId: input.tenantId,
            agentId: input.agentId,
            ...buildIntentFirewallBlockPayload(
              input.speechText,
              gate,
              isConversationalSupportQuery(input.speechText, input.intent)
                ? 'conversational_support'
                : 'openai_fallback',
            ),
          }),
        );
      }
      return miss;
    }

    if (isConversationalSupportQuery(input.speechText, input.intent)) {
      this.logger.error(
        JSON.stringify({
          event: 'voice.intent.firewall.sla_violation',
          callSessionId: input.callSessionId,
          tenantId: input.tenantId,
          agentId: input.agentId,
          violation: 'shopify_called_on_conversational_query',
          shopifyCalled: false,
          originalSpeech: input.speechText.slice(0, 500),
        }),
      );
      return miss;
    }

    const priceOnly =
      input.intent === 'product_question' &&
      /\b(price|cost|how much)\b/i.test(input.speechText) &&
      Boolean(discussedTitle);

    const query = priceOnly && discussedTitle
      ? discussedTitle
      : extractProductSearchQuery(input.speechText);

    if (!query.trim()) return miss;

    const searchStarted = Date.now();
    const search = await this.shopifyAgent.searchProducts(
      input.tenantId,
      input.agentId,
      query,
      3,
    );
    const localProductSearchMs = Date.now() - searchStarted;

    const topScore = search.searchVoiceLog?.topScore ?? search.products?.[0]?.relevanceScore ?? 0;
    const productFastPathConfidence = normalizeProductFastPathConfidence(topScore);
    const shopifySkipped = search.searchVoiceLog?.bookstoreSearch?.shopifyLatencyMs === 0 ||
      search.searchVoiceLog?.bookstoreSearch?.fallbackStage === 'fuzzy_local' ||
      search.searchVoiceLog?.bookstoreSearch?.fallbackStage === 'cache' ||
      (search.searchVoiceLog?.bookstoreSearch?.cacheHit === true && localProductSearchMs < 120) ||
      shouldSkipShopifyForFastPath(productFastPathConfidence);

    const reply = buildDeterministicProductReply({
      products: search.products ?? [],
      topScore,
      discussedTitle,
      priceOnly,
    });

    const totalMs = localProductSearchMs;
    const slaPassed = totalMs <= PRODUCT_FAST_PATH_SLA_MS;

    this.logger.log(
      JSON.stringify({
        event: 'voice.product_fast_path',
        callSessionId: input.callSessionId,
        tenantId: input.tenantId,
        agentId: input.agentId,
        query: query.slice(0, 120),
        product_fast_path_used: true,
        openaiCalled: false,
        brain: 'deterministic_product_fast_path',
        localProductSearchMs,
        shopifySkipped,
        productFastPathConfidence,
        productsFound: search.products?.length ?? 0,
        replyPreview: reply.slice(0, 160),
      }),
    );

    if (slaPassed) {
      this.logger.log(
        JSON.stringify({
          event: 'voice.fast_path.sla_passed',
          callSessionId: input.callSessionId,
          localProductSearchMs,
          slaTargetMs: PRODUCT_FAST_PATH_SLA_MS,
        }),
      );
    } else if (localProductSearchMs > PRODUCT_FAST_PATH_LOCAL_SLA_MS) {
      this.logger.warn(
        JSON.stringify({
          event: 'voice.fast_path.sla_slow',
          callSessionId: input.callSessionId,
          localProductSearchMs,
          localTargetMs: PRODUCT_FAST_PATH_LOCAL_SLA_MS,
        }),
      );
    }

    return {
      used: true,
      reply,
      localProductSearchMs,
      shopifySkipped,
      productFastPathConfidence,
      openaiCalled: false,
      product_fast_path_used: true,
      brain: 'deterministic_product_fast_path',
    };
  }
}
