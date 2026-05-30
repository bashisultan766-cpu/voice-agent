import { Injectable, Logger } from '@nestjs/common';
import { VoiceSearchService } from '../../voice/voice-search.service';
import { ShopifySearchAgent } from './shopify-search.agent';
import type { AgentTaskResult, VoiceGraphState } from '../types/voice-turn.types';

const ISBN_EXTRACT = /\b(?:97[89]\d{10}|\d{9}[\dXx]|\d{13})\b/;

@Injectable()
export class IsbnSearchAgent {
  private readonly logger = new Logger(IsbnSearchAgent.name);

  constructor(
    private readonly voiceSearch: VoiceSearchService,
    private readonly shopifySearch: ShopifySearchAgent,
  ) {}

  async search(state: VoiceGraphState): Promise<AgentTaskResult> {
    const started = Date.now();
    const match = state.utterance.match(ISBN_EXTRACT);
    const isbn = match?.[0]?.replace(/[-\s]/g, '') ?? '';
    if (!isbn) {
      return {
        agent: 'isbn_search',
        ok: false,
        error: 'no_isbn_detected',
        latencyMs: Date.now() - started,
      };
    }

    const { tenantId, agentId } = state.context;
    try {
      const result = await this.voiceSearch.searchProduct({
        query: isbn,
        tenantId,
        agentId,
        limit: 3,
      });
      const products = this.shopifySearch.normalizeProducts(result.products ?? []).map((p) => ({
        ...p,
        isbn,
      }));
      return {
        agent: 'isbn_search',
        ok: result.success && products.length > 0,
        data: {
          products,
          isbn,
          source: 'shopify_graphql',
          cacheHit: result.cacheHit ?? false,
          exactIsbnMatch: products.length === 1,
        },
        latencyMs: Math.max(result.latencyMs ?? 0, Date.now() - started),
      };
    } catch (err) {
      this.logger.warn(`IsbnSearchAgent: ${(err as Error).message}`);
      return {
        agent: 'isbn_search',
        ok: false,
        error: (err as Error).message,
        latencyMs: Date.now() - started,
      };
    }
  }
}
