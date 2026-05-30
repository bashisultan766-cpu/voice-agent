import { Injectable, Logger } from '@nestjs/common';
import {
  RealtimeVoiceProductSearchService,
  REALTIME_SLOW_SEARCH_FILLER,
} from '../../search/realtime/realtime-voice-product-search.service';
import { VoiceE2ETraceService } from '../observability/voice-e2e-trace.service';
import type { ShopifyProductSummary } from '../../agents/shopify-agent.service';
import type { AgentTaskResult, VoiceGraphState } from '../types/voice-turn.types';

export type NormalizedVoiceProduct = {
  id: string;
  variantId: string;
  title: string;
  price?: string;
  inStock: boolean;
};

@Injectable()
export class ShopifySearchAgent {
  private readonly logger = new Logger(ShopifySearchAgent.name);

  constructor(
    private readonly productSearch: RealtimeVoiceProductSearchService,
    private readonly e2eTrace: VoiceE2ETraceService,
  ) {}

  async search(state: VoiceGraphState): Promise<AgentTaskResult> {
    const started = Date.now();
    const query = state.utterance.trim();
    const { tenantId, agentId } = state.context;

    void this.e2eTrace.record(state.callSessionId, 'product_search_started', {
      metadata: { query: query.slice(0, 80) },
      provider: 'shopify',
    });

    try {
      const result = await this.productSearch.search(tenantId, agentId, query, 5);
      const products = this.normalizeProducts(result.products ?? []);

      return {
        agent: 'shopify_search',
        ok: result.ok || result.slowSearchFiller,
        data: {
          products,
          source: result.source,
          cacheHit: result.cacheHit,
          slowSearchFiller: result.slowSearchFiller,
          slowSearchMessage: result.slowSearchFiller ? REALTIME_SLOW_SEARCH_FILLER : undefined,
          timedOut: result.timedOut,
          matchCount: result.matchCount,
        },
        latencyMs: Math.max(result.latencyMs, Date.now() - started),
      };
    } catch (err) {
      this.logger.warn(`ShopifySearchAgent: ${(err as Error).message}`);
      return {
        agent: 'shopify_search',
        ok: false,
        error: (err as Error).message,
        latencyMs: Date.now() - started,
      };
    }
  }

  normalizeProducts(raw: ShopifyProductSummary[]): NormalizedVoiceProduct[] {
    return raw.slice(0, 5).map((p) => {
      const variant = p.variants[0];
      const inStock = (variant?.inventory_quantity ?? 0) > 0 || variant?.availableForSale !== false;
      return {
        id: p.id ?? p.productId,
        variantId: variant?.id ?? p.productId,
        title: p.title,
        price: variant?.price ?? undefined,
        inStock,
      };
    });
  }
}
