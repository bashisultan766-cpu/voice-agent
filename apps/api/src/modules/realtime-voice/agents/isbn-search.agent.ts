import { Injectable, Logger } from '@nestjs/common';
import {
  RealtimeVoiceProductSearchService,
  REALTIME_SLOW_SEARCH_FILLER,
} from '../../search/realtime/realtime-voice-product-search.service';
import { ShopifySearchAgent } from './shopify-search.agent';
import type { AgentTaskResult, VoiceGraphState } from '../types/voice-turn.types';

const ISBN_EXTRACT = /\b(?:97[89]\d{10}|\d{9}[\dXx]|\d{13})\b/;

@Injectable()
export class IsbnSearchAgent {
  private readonly logger = new Logger(IsbnSearchAgent.name);

  constructor(
    private readonly productSearch: RealtimeVoiceProductSearchService,
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
      const result = await this.productSearch.search(tenantId, agentId, isbn, 3);
      const products = this.shopifySearch.normalizeProducts(result.products ?? []).map((p) => ({
        ...p,
        isbn,
      }));
      return {
        agent: 'isbn_search',
        ok: products.length > 0 || result.slowSearchFiller,
        data: {
          products,
          isbn,
          source: result.source,
          slowSearchFiller: result.slowSearchFiller,
          slowSearchMessage: result.slowSearchFiller ? REALTIME_SLOW_SEARCH_FILLER : undefined,
          exactIsbnMatch: products.length === 1,
        },
        latencyMs: Math.max(result.latencyMs, Date.now() - started),
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
