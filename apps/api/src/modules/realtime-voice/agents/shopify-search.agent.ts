import { Injectable, Logger } from '@nestjs/common';
import { VoiceSearchService } from '../../voice/voice-search.service';
import { VoiceE2ETraceService } from '../observability/voice-e2e-trace.service';
import type { AgentTaskResult, VoiceGraphState } from '../types/voice-turn.types';
import type { VoiceCatalogProduct } from '../../shopify/types/voice-product.types';

export type NormalizedVoiceProduct = {
  id: string;
  variantId: string;
  title: string;
  price?: string;
  inStock: boolean;
  score?: number;
};

@Injectable()
export class ShopifySearchAgent {
  private readonly logger = new Logger(ShopifySearchAgent.name);

  constructor(
    private readonly voiceSearch: VoiceSearchService,
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
      const result = await this.voiceSearch.searchProduct({
        query,
        tenantId,
        agentId,
        limit: 5,
      });
      const products = this.normalizeProducts(result.products ?? []);

      return {
        agent: 'shopify_search',
        ok: result.success,
        data: {
          products,
          source: 'shopify_graphql',
          cacheHit: result.cacheHit ?? false,
          matchCount: products.length,
          error: result.error,
        },
        latencyMs: Math.max(result.latencyMs ?? 0, Date.now() - started),
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

  normalizeProducts(raw: VoiceCatalogProduct[]): NormalizedVoiceProduct[] {
    return raw.slice(0, 5).map((p) => ({
      id: p.productId,
      variantId: p.variantId,
      title: p.title,
      price: p.price ?? undefined,
      inStock: p.inStock,
      score: p.score,
    }));
  }
}
