import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ShopifyAgentService, type ShopifyProductSummary } from '../../agents/shopify-agent.service';
import { BookstoreVoiceSearchService } from '../bookstore-voice-search.service';
import { BookstoreSearchCacheService } from '../bookstore-search-cache.service';
import { parseRealtimeSearchQuery, primarySearchTerm } from './realtime-search-query.util';
import type { BookstoreVoiceSearchResult } from '../types/bookstore-search.types';
import { LOCAL_SEARCH_SKIP_SHOPIFY_MIN_SCORE } from '../bookstore-local-first.util';

export const REALTIME_VOICE_SEARCH_DEADLINE_MS = 800;
export const REALTIME_SLOW_SEARCH_FILLER = "I'm checking live inventory now.";

export type RealtimeVoiceSearchSource =
  | 'redis_cache'
  | 'memory_cache'
  | 'postgres_index'
  | 'shopify_live'
  | 'partial_timeout'
  | 'none';

export type RealtimeVoiceSearchResult = {
  ok: boolean;
  products: ShopifyProductSummary[];
  voiceSummary?: string;
  source: RealtimeVoiceSearchSource;
  latencyMs: number;
  cacheHit: boolean;
  slowSearchFiller: boolean;
  timedOut: boolean;
  queryKind: string;
  matchCount: number;
};

function sleep(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));
}

@Injectable()
export class RealtimeVoiceProductSearchService {
  private readonly logger = new Logger(RealtimeVoiceProductSearchService.name);
  private readonly deadlineMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly cache: BookstoreSearchCacheService,
    private readonly voiceSearch: BookstoreVoiceSearchService,
    private readonly shopifyAgent: ShopifyAgentService,
  ) {
    this.deadlineMs = Number(this.config.get('REALTIME_VOICE_SEARCH_DEADLINE_MS')) || REALTIME_VOICE_SEARCH_DEADLINE_MS;
  }

  /** Redis → PostgreSQL index → Shopify live (never live first). Hard deadline for voice. */
  async search(
    tenantId: string,
    agentId: string,
    query: string,
    limit = 5,
  ): Promise<RealtimeVoiceSearchResult> {
    const started = Date.now();
    const parsed = parseRealtimeSearchQuery(query);
    const searchTerm = primarySearchTerm(parsed);

    if (!searchTerm) {
      return this.emptyResult(started, parsed.kind);
    }

    // 1. Redis + memory cache (parallel typo variants)
    for (const variant of parsed.typoVariants) {
      const cacheLookup = await this.cache.lookupParallel(tenantId, agentId, variant);
      const hit = cacheLookup.memory ?? cacheLookup.redis;
      if (hit?.products?.length) {
        void this.cache.recordPopularSearch(tenantId, agentId, variant);
        return this.fromBookstoreResult(hit, {
          started,
          source: cacheLookup.memoryHit ? 'memory_cache' : 'redis_cache',
          cacheHit: true,
          queryKind: parsed.kind,
        });
      }
    }

    const elapsedAfterCache = Date.now() - started;
    const remaining = this.deadlineMs - elapsedAfterCache;
    if (remaining <= 0) {
      return this.timeoutPartial(started, parsed.kind, [], 'none');
    }

    // 2. PostgreSQL indexed catalog (local — no Shopify live)
    const local = await Promise.race([
      this.voiceSearch.searchIndexedOnly({
        tenantId,
        agentId,
        query: searchTerm,
        limit,
      }),
      sleep(remaining),
    ]);

    if (local === 'timeout') {
      void this.backgroundFullSearch(tenantId, agentId, searchTerm, limit);
      return this.timeoutPartial(started, parsed.kind, [], 'postgres_index');
    }

    if (local.products?.length) {
      void this.cache.recordPopularSearch(tenantId, agentId, parsed.normalized);
      const topScore = local.searchVoiceLog?.topScore ?? 0;
      if (topScore >= LOCAL_SEARCH_SKIP_SHOPIFY_MIN_SCORE) {
        return this.fromBookstoreResult(local, {
          started,
          source: 'postgres_index',
          cacheHit: false,
          queryKind: parsed.kind,
        });
      }
    }

    const elapsedAfterIndex = Date.now() - started;
    const liveBudget = this.deadlineMs - elapsedAfterIndex;
    if (liveBudget <= 80) {
      void this.backgroundFullSearch(tenantId, agentId, searchTerm, limit);
      return this.timeoutPartial(
        started,
        parsed.kind,
        local.products ?? [],
        'postgres_index',
      );
    }

    // 3. Shopify live fallback (only after cache + index miss, within remaining budget)
    const live = await Promise.race([
      this.shopifyAgent.searchProducts(tenantId, agentId, searchTerm, limit),
      sleep(liveBudget),
    ]);

    if (live === 'timeout') {
      void this.backgroundFullSearch(tenantId, agentId, searchTerm, limit);
      return this.timeoutPartial(
        started,
        parsed.kind,
        local.products ?? [],
        local.products?.length ? 'postgres_index' : 'partial_timeout',
      );
    }

    void this.cache.recordPopularSearch(tenantId, agentId, parsed.normalized);
    if (live.ok && live.products?.length) {
      this.cache.setMemory(tenantId, agentId, parsed.normalized, {
        ok: true,
        products: live.products,
        voiceSummary: live.voiceSummary,
      });
      void this.cache.setRedis(tenantId, agentId, parsed.normalized, {
        ok: true,
        products: live.products,
        voiceSummary: live.voiceSummary,
      });
      return {
        ok: true,
        products: live.products,
        voiceSummary: live.voiceSummary,
        source: 'shopify_live',
        latencyMs: Date.now() - started,
        cacheHit: false,
        slowSearchFiller: false,
        timedOut: false,
        queryKind: parsed.kind,
        matchCount: live.products.length,
      };
    }

    if (local.products?.length) {
      return this.fromBookstoreResult(local, {
        started,
        source: 'postgres_index',
        cacheHit: false,
        queryKind: parsed.kind,
      });
    }

    return {
      ok: false,
      products: [],
      voiceSummary: live.voiceSummary,
      source: 'shopify_live',
      latencyMs: Date.now() - started,
      cacheHit: false,
      slowSearchFiller: false,
      timedOut: false,
      queryKind: parsed.kind,
      matchCount: 0,
    };
  }

  private fromBookstoreResult(
    result: BookstoreVoiceSearchResult,
    meta: {
      started: number;
      source: RealtimeVoiceSearchSource;
      cacheHit: boolean;
      queryKind: string;
    },
  ): RealtimeVoiceSearchResult {
    const products = result.products ?? [];
    return {
      ok: result.ok && products.length > 0,
      products,
      voiceSummary: result.voiceSummary,
      source: meta.source,
      latencyMs: Date.now() - meta.started,
      cacheHit: meta.cacheHit,
      slowSearchFiller: false,
      timedOut: false,
      queryKind: meta.queryKind,
      matchCount: products.length,
    };
  }

  private timeoutPartial(
    started: number,
    queryKind: string,
    products: ShopifyProductSummary[],
    source: RealtimeVoiceSearchSource,
  ): RealtimeVoiceSearchResult {
    return {
      ok: products.length > 0,
      products,
      voiceSummary: products.length ? undefined : REALTIME_SLOW_SEARCH_FILLER,
      source: source === 'none' ? 'partial_timeout' : source,
      latencyMs: Date.now() - started,
      cacheHit: false,
      slowSearchFiller: true,
      timedOut: true,
      queryKind,
      matchCount: products.length,
    };
  }

  private emptyResult(started: number, queryKind: string): RealtimeVoiceSearchResult {
    return {
      ok: false,
      products: [],
      source: 'none',
      latencyMs: Date.now() - started,
      cacheHit: false,
      slowSearchFiller: false,
      timedOut: false,
      queryKind,
      matchCount: 0,
    };
  }

  private backgroundFullSearch(tenantId: string, agentId: string, query: string, limit: number): void {
    void this.shopifyAgent.searchProducts(tenantId, agentId, query, limit).catch((err) => {
      this.logger.debug(
        JSON.stringify({
          event: 'realtime.search.background_failed',
          message: (err as Error).message,
        }),
      );
    });
  }
}
