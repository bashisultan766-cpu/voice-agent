import { Injectable, Logger } from '@nestjs/common';
import {
  isVoiceCommerceFastMode,
  voiceShopifyMaxAttempts,
  voiceShopifySearchFirst,
} from '../calls/runtime/voice-commerce-fast-mode.util';
import type { ShopifyProductSummary, ShopifyProductSearchVoiceLog } from '../agents/shopify-agent.service';
import {
  PRODUCT_SEARCH_CONFIDENT_MIN_SCORE,
  PRODUCT_SEARCH_CONFIRM_MIN_SCORE,
  normalizeForMatch,
} from '../agents/shopify-product-relevance.util';
import {
  buildShopifyProductSearchAttempts,
  cleanVoiceProductQuery,
} from '../agents/voice-product-query.util';
import type { ShopifySearchAttempt } from '../agents/voice-product-query.util';
import {
  buildProductSearchVoiceSummary,
  pickInStockSearchPresentation,
} from '../calls/runtime/voice-stock-sales-policy.util';
import type { VoiceProductOfferInput } from '../calls/runtime/book-sales-voice.util';
import { detectBookCategoryQuery, formatCategorySearchVoiceSummary } from '../calls/runtime/book-sales-voice.util';
import { BookstoreProductIndexService } from './bookstore-product-index.service';
import { BookstoreSearchCacheService, POPULAR_WARM_QUERIES } from './bookstore-search-cache.service';
import { retrieveFromCatalogIndex } from './ranking/bookstore-catalog-retrieval.util';
import {
  pickSimilarRecommendations,
  rankBookstoreProducts,
} from './ranking/bookstore-ranking.engine';
import type { BookstoreIndexProduct } from './types/bookstore-search.types';
import type { BookstoreSearchFallbackStage } from './types/bookstore-search.types';
import { normalizeBookTitleForSearch } from './ranking/bookstore-title-normalizer.util';
import type {
  BookstoreConfidenceTier,
  BookstoreSearchDiagnostics,
  BookstoreVoiceSearchResult,
} from './types/bookstore-search.types';
import {
  buildPremiumSearchVoiceSummary,
  buildSimilarBooksVoiceLead,
} from './voice/bookstore-voice-copy.util';
import { logVoiceSearchLatency } from './voice-search-performance.util';
import {
  LOCAL_SEARCH_SKIP_SHOPIFY_MIN_SCORE,
} from './bookstore-local-first.util';

export interface BookstoreLiveFetchInput {
  storeUrl: string;
  token: string;
  attempts: ShopifySearchAttempt[];
  limitPerQuery: number;
}

@Injectable()
export class BookstoreVoiceSearchService {
  private readonly logger = new Logger(BookstoreVoiceSearchService.name);

  constructor(
    private readonly cache: BookstoreSearchCacheService,
    private readonly index: BookstoreProductIndexService,
  ) {}

  warmPopularQueries(tenantId: string, agentId: string): void {
    for (const q of POPULAR_WARM_QUERIES) {
      this.cache.markWarmQuery(tenantId, agentId, q);
    }
  }

  /** Startup / agent bind: warm in-memory keys and prefetch index from productCache. */
  async warmAgentCatalog(tenantId: string, agentId: string, shopDomain?: string | null): Promise<void> {
    for (const q of POPULAR_WARM_QUERIES) {
      this.cache.markWarmQuery(tenantId, agentId, q);
    }
    try {
      await this.index.getIndex(tenantId, agentId, shopDomain);
      if (shopDomain) {
        void this.cache.setCatalogSnapshot(tenantId, agentId, shopDomain, 0);
      }
    } catch (err) {
      this.logger.warn(
        `warmAgentCatalog failed: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`,
      );
    }
  }

  schedulePopularQueryPrefetch(
    tenantId: string,
    agentId: string,
    shopDomain: string | null | undefined,
    storeUrl: string,
    token: string,
    fetchLive: (args: BookstoreLiveFetchInput) => Promise<{
      products: ShopifyProductSummary[];
      shopifyQueriesTried: ShopifySearchAttempt[];
    }>,
  ): void {
    void this.prefetchPopularQueries(tenantId, agentId, shopDomain, storeUrl, token, fetchLive);
  }

  private async prefetchPopularQueries(
    tenantId: string,
    agentId: string,
    shopDomain: string | null | undefined,
    storeUrl: string,
    token: string,
    fetchLive: (args: BookstoreLiveFetchInput) => Promise<{
      products: ShopifyProductSummary[];
      shopifyQueriesTried: ShopifySearchAttempt[];
    }>,
  ): Promise<void> {
    if (!isVoiceCommerceFastMode()) return;
    const recent = this.cache.getRecentSearches(tenantId, agentId, 6);
    const queries = [...new Set([...recent, ...POPULAR_WARM_QUERIES.slice(0, 6)])].slice(0, 8);
    await Promise.allSettled(
      queries.map((q) =>
        this.search({
          tenantId,
          agentId,
          query: q,
          limit: 3,
          shopDomain,
          storeUrl,
          token,
          fetchLive,
        }),
      ),
    );
  }

  async search(
    input: {
      tenantId: string;
      agentId: string;
      query: string;
      limit: number;
      shopDomain?: string | null;
      fetchLive: (args: BookstoreLiveFetchInput) => Promise<{
        products: ShopifyProductSummary[];
        shopifyQueriesTried: ShopifySearchAttempt[];
      }>;
      storeUrl: string;
      token: string;
    },
  ): Promise<BookstoreVoiceSearchResult> {
    const started = Date.now();
    const productSearchInputRaw = input.query.trim();
    const normalizedCacheKey = normalizeBookTitleForSearch(productSearchInputRaw);

    if (!productSearchInputRaw) {
      return this.emptyQueryResult();
    }

    const { cleanedQuery, probableTitle } = cleanVoiceProductQuery(productSearchInputRaw);
    const attemptsAll = buildShopifyProductSearchAttempts({
      probableTitle,
      cleanedQuery,
      productSearchInputRaw,
    });
    const attempts = attemptsAll.slice(0, voiceShopifyMaxAttempts(attemptsAll.length));

    if (this.cache.shouldDebounce(input.tenantId, input.agentId, normalizedCacheKey)) {
      const mem = this.cache.getMemoryHit(input.tenantId, input.agentId, normalizedCacheKey);
      if (mem) {
        return this.wrapCacheResult(mem, productSearchInputRaw, started, true, true);
      }
    }

    const cacheLookup = await this.cache.lookupParallel(input.tenantId, input.agentId, normalizedCacheKey);
    if (cacheLookup.memory) {
      return this.wrapCacheResult(cacheLookup.memory, productSearchInputRaw, started, true, false, cacheLookup);
    }
    if (cacheLookup.redis) {
      this.cache.setMemory(input.tenantId, input.agentId, normalizedCacheKey, cacheLookup.redis);
      return this.wrapCacheResult(cacheLookup.redis, productSearchInputRaw, started, true, false, {
        ...cacheLookup,
        memoryHit: false,
        redisHit: true,
      });
    }
    this.cache.logCacheMiss(input.tenantId, input.agentId, normalizedCacheKey);

    const indexStarted = Date.now();
    const { products: indexProducts, embeddings } = await this.index.getIndex(
      input.tenantId,
      input.agentId,
      input.shopDomain,
    );
    const indexLoadMs = Date.now() - indexStarted;

    let shopifyLatencyMs = 0;
    let rawProducts: ShopifyProductSummary[] = [];
    let shopifyQueriesTried: ShopifySearchAttempt[] = [];
    let shopifySkipped = false;

    const localFirst = await this.tryLocalCatalogOnlySearch({
      tenantId: input.tenantId,
      agentId: input.agentId,
      shopDomain: input.shopDomain,
      indexProducts,
      embeddings,
      productSearchInputRaw,
      probableTitle,
      cleanedQuery,
      limit: input.limit,
    });

    if (localFirst.sufficient) {
      rawProducts = localFirst.products;
      shopifySkipped = true;
      this.logger.log(
        JSON.stringify({
          event: 'bookstore.search.local_first_hit',
          tenantId: input.tenantId,
          agentId: input.agentId,
          query: productSearchInputRaw.slice(0, 80),
          products: rawProducts.length,
          bestScore: localFirst.bestScore,
          shopifySkipped: true,
        }),
      );
    } else {
      const shopifyStarted = Date.now();
      const shopifyResult = await input.fetchLive({
        storeUrl: input.storeUrl,
        token: input.token,
        attempts,
        limitPerQuery: voiceShopifySearchFirst(),
      });
      shopifyLatencyMs = Date.now() - shopifyStarted;
      rawProducts = shopifyResult.products;
      shopifyQueriesTried = shopifyResult.shopifyQueriesTried;
      if (localFirst.products.length > 0 && rawProducts.length === 0) {
        rawProducts = localFirst.products;
      }
    }
    const parallelMs = shopifyLatencyMs;

    if (input.shopDomain) {
      void this.cache.setCatalogSnapshot(input.tenantId, input.agentId, input.shopDomain, indexProducts.length);
    }

    const localIds = this.index.localCandidateIds(indexProducts, probableTitle || cleanedQuery);

    let boosted = this.prioritizeLocalHits(rawProducts, localIds);
    let fallbackStage: BookstoreSearchFallbackStage = shopifySkipped
      ? 'fuzzy_local'
      : rawProducts.length > 0
        ? 'shopify_live'
        : 'none';
    let vectorLatencyMs = 0;
    let catalogSemanticConfidence = 0;
    let catalogSemanticReason: string | null = null;
    let catalogRerankScore = 0;
    let catalogSemanticActivated = false;

    const needsCatalogRecovery =
      indexProducts.length > 0 &&
      (rawProducts.length === 0 ||
        localIds.length === 0 ||
        (rawProducts.length > 0 && rawProducts.length < 3));

    if (needsCatalogRecovery) {
      const catalogResult = retrieveFromCatalogIndex(
        indexProducts,
        productSearchInputRaw,
        probableTitle || cleanedQuery || productSearchInputRaw,
        20,
      );
      vectorLatencyMs = catalogResult.vectorLatencyMs;
      catalogSemanticConfidence = catalogResult.semanticConfidence;
      catalogSemanticReason = catalogResult.semanticMatchReason;
      catalogSemanticActivated = catalogResult.semanticSearchActivated;
      catalogRerankScore = catalogResult.candidates[0]?.rerankScore ?? 0;
      if (catalogResult.fallbackStage !== 'none') {
        fallbackStage =
          rawProducts.length > 0 ? 'combined' : (catalogResult.fallbackStage as BookstoreSearchFallbackStage);
      }

      const hydrateIds = catalogResult.candidates.slice(0, 12).map((c) => c.productId);
      const hydrated = await this.index.hydrateProducts(
        input.tenantId,
        input.agentId,
        input.shopDomain,
        hydrateIds,
      );
      boosted = this.mergeUniqueProducts(boosted, hydrated);
      if (boosted.length > 0 && rawProducts.length === 0) {
        boosted = this.prioritizeLocalHits(boosted, hydrateIds);
      }
    }

    const normalizedQuery = normalizeForMatch(probableTitle || cleanedQuery || productSearchInputRaw);
    const maxVoiceHits = Math.min(5, Math.max(1, input.limit));
    const embeddingMaps = this.buildEmbeddingMaps(indexProducts);

    const rankingStarted = Date.now();
    const ranking = rankBookstoreProducts({
      queryOriginal: productSearchInputRaw,
      probableTitle: probableTitle || cleanedQuery || productSearchInputRaw,
      products: boosted,
      maxResults: maxVoiceHits,
      indexEmbeddings: embeddings,
      indexAuthorEmbeddings: embeddingMaps.author,
      indexCategoryEmbeddings: embeddingMaps.category,
      indexDescriptionEmbeddings: embeddingMaps.description,
      catalogSemanticRecovery: catalogSemanticActivated || rawProducts.length === 0,
    });
    const semanticRankingLatencyMs = Date.now() - rankingStarted;

    const similar = pickSimilarRecommendations(
      probableTitle || productSearchInputRaw,
      boosted.map((p) => ({
        title: p.title,
        vendor: p.vendor,
        relevanceScore: p.relevanceScore ?? 0,
        matchReason: p.matchReason ?? 'unknown',
        seriesKey: null,
      })),
      3,
    );

    const products: ShopifyProductSummary[] = [];
    for (const r of ranking.ranked) {
      const full = boosted.find((b) => b.productId === r.productId);
      if (!full) continue;
      products.push({
        ...full,
        relevanceScore: r.relevanceScore,
        matchReason: r.matchReason,
      });
    }
    let productsOut = products;

    const toOffer = (p: ShopifyProductSummary): VoiceProductOfferInput => ({
      title: p.title,
      variants: p.variants.map((v) => ({
        price: v.price,
        inventory_quantity: v.inventory_quantity,
        availableForSale: v.availableForSale,
      })),
    });

    const categoryLabel = detectBookCategoryQuery(productSearchInputRaw);
    const exactMatchFound = ranking.bestScore >= PRODUCT_SEARCH_CONFIDENT_MIN_SCORE;
    const confidenceTier = ranking.confidenceTier;
    let finalVoiceSummary: string;

    if (
      ranking.bestScore < PRODUCT_SEARCH_CONFIRM_MIN_SCORE ||
      productsOut.length === 0
    ) {
      if (productsOut.length === 0 && ranking.ranked.length > 0) {
        productsOut = ranking.ranked
          .map((r) => boosted.find((b) => b.productId === r.productId))
          .filter((p): p is ShopifyProductSummary => Boolean(p))
          .slice(0, 3);
      }
      if (similar.length > 0) {
        const altProducts = similar
          .map((s) => boosted.find((b) => b.title === s.title))
          .filter((p): p is ShopifyProductSummary => Boolean(p));
        productsOut = altProducts.slice(0, 3);
        const lead = buildSimilarBooksVoiceLead(productsOut.length);
        const premium = buildPremiumSearchVoiceSummary({
          queryDisplay: probableTitle || cleanedQuery || productSearchInputRaw,
          primaryTitle: productsOut[0]?.title ?? similar[0]!.title,
          primaryVendor: productsOut[0]?.vendor,
          confidenceTier: 'MEDIUM',
          similarAlternatives: similar.map((s) => ({ title: s.title, vendor: s.vendor })),
          exactMatchFound: false,
        });
        finalVoiceSummary = `${lead} ${premium}`;
      } else {
        productsOut = [];
        finalVoiceSummary = buildPremiumSearchVoiceSummary({
          queryDisplay: probableTitle || cleanedQuery || productSearchInputRaw,
          primaryTitle: '',
          confidenceTier: 'LOW',
          exactMatchFound: false,
        });
      }
    } else if (categoryLabel && productsOut.length > 1) {
      finalVoiceSummary = formatCategorySearchVoiceSummary(categoryLabel, productsOut.map(toOffer));
    } else {
      const stockPick = pickInStockSearchPresentation(productsOut, toOffer);
      const requiresClarification = confidenceTier === 'MEDIUM' && !stockPick.topWasOutOfStock;
      if (!exactMatchFound && similar.length > 0 && !stockPick.topWasOutOfStock) {
        finalVoiceSummary = buildPremiumSearchVoiceSummary({
          queryDisplay: probableTitle || cleanedQuery || productSearchInputRaw,
          primaryTitle: stockPick.primary.title,
          primaryVendor: stockPick.primary.vendor,
          confidenceTier,
          similarAlternatives: similar.map((s) => ({ title: s.title, vendor: s.vendor })),
          exactMatchFound: false,
        });
      } else {
        finalVoiceSummary = buildProductSearchVoiceSummary({
          primary: toOffer(stockPick.primary),
          topWasOutOfStock: stockPick.topWasOutOfStock,
          unavailableTitle: stockPick.unavailableTitle,
          requiresClarification,
        });
        if (requiresClarification) {
          finalVoiceSummary = buildPremiumSearchVoiceSummary({
            queryDisplay: probableTitle || cleanedQuery || productSearchInputRaw,
            primaryTitle: stockPick.primary.title,
            primaryVendor: stockPick.primary.vendor,
            confidenceTier: 'MEDIUM',
            exactMatchFound: ranking.bestScore >= PRODUCT_SEARCH_CONFIDENT_MIN_SCORE,
          });
        }
      }
      if (productsOut.length > 1 && !categoryLabel && !stockPick.topWasOutOfStock && exactMatchFound) {
        finalVoiceSummary = `${finalVoiceSummary} I also have other matches if you want to hear them.`;
      }
      if (stockPick.primary.productId !== productsOut[0]?.productId) {
        productsOut = [
          stockPick.primary,
          ...productsOut.filter((p) => p.productId !== stockPick.primary.productId),
        ].slice(0, productsOut.length);
      }
    }

    const searchLatencyMs = Date.now() - started;
    const slowPath =
      searchLatencyMs >= 2000 || shopifyLatencyMs >= 1500 || semanticRankingLatencyMs >= 400;
    const semanticSearchUsed = ranking.semanticSearchUsed || catalogSemanticActivated;
    const bookstoreSearch: BookstoreSearchDiagnostics = {
      fuzzySearchActivated: ranking.fuzzySearchActivated,
      semanticSearchUsed,
      semanticSearchActivated: ranking.semanticSearchActivated || catalogSemanticActivated,
      semanticConfidence: Math.max(ranking.semanticConfidence, catalogSemanticConfidence),
      semanticMatchReason: ranking.semanticMatchReason ?? catalogSemanticReason,
      rerankScore: Math.max(ranking.rerankScore, catalogRerankScore),
      vectorLatencyMs,
      fallbackStage,
      cacheHit: false,
      memoryHit: false,
      redisHit: false,
      searchLatencyMs,
      shopifyLatencyMs,
      semanticRankingLatencyMs,
      cacheLookupMs: cacheLookup.cacheLookupMs,
      indexLoadMs,
      slowPath,
      confidenceTier,
      topResultConfidence: ranking.bestScore,
      recommendedBooks: (productsOut.length ? productsOut : similar).map((p) => ({
        title: 'title' in p ? p.title : (p as { title: string }).title,
        score: 'relevanceScore' in p ? (p as { relevanceScore?: number }).relevanceScore ?? 0 : (p as { score: number }).score,
        matchReason: 'matchReason' in p ? String((p as { matchReason?: string }).matchReason) : 'similar',
        vendor: 'vendor' in p ? (p as { vendor?: string | null }).vendor : undefined,
      })),
      rankingDiagnostics: ranking.diagnostics,
      debounced: false,
      parallelShopifyQueries: shopifyQueriesTried.length,
      indexSize: indexProducts.length,
    };

    const searchVoiceLog: ShopifyProductSearchVoiceLog & {
      bookstoreSearch?: BookstoreSearchDiagnostics;
      confidenceTier?: BookstoreConfidenceTier;
    } = {
      productSearchInputRaw,
      cleanedQuery,
      probableTitle,
      shopifyQueriesTried: shopifyQueriesTried.map((a) => ({ label: a.label, query: a.query })),
      productsReturned: rawProducts.length,
      productsReturnedCount: rawProducts.length,
      productsAfterRanking: ranking.productsAfterRanking,
      rankedProducts: ranking.rankedForLog,
      topProduct: ranking.topProduct,
      topProductTitle: ranking.topProduct,
      topScore: ranking.bestScore,
      topMatchReason: ranking.bestReason,
      lowConfidenceSearch: ranking.lowConfidence || ranking.bestScore < PRODUCT_SEARCH_CONFIRM_MIN_SCORE,
      finalVoiceSummary,
      queryOriginal: productSearchInputRaw,
      normalizedQuery,
      productsReturnedByShopify: rawProducts.length,
      topRelevanceScore: ranking.bestScore,
      matchReason: ranking.bestReason,
      bookstoreSearch,
      confidenceTier,
    };

    logVoiceSearchLatency('bookstore.voice.search', {
      searchLatencyMs,
      cacheHit: false,
      shopifyLatencyMs,
      semanticRankingLatencyMs,
      indexLoadMs,
      memoryHit: false,
      redisHit: false,
      tenantId: input.tenantId,
      agentId: input.agentId,
      fuzzySearchActivated: bookstoreSearch.fuzzySearchActivated,
      semanticSearchUsed: bookstoreSearch.semanticSearchUsed,
      parallelShopifyMs: parallelMs,
      confidenceTier: bookstoreSearch.confidenceTier,
      productsFound: productsOut.length,
    });

    const result: BookstoreVoiceSearchResult = {
      ok: true,
      products: productsOut,
      voiceSummary: finalVoiceSummary,
      searchVoiceLog,
    };

    this.cache.setMemory(input.tenantId, input.agentId, normalizedCacheKey, result);
    void this.cache.setRedis(input.tenantId, input.agentId, normalizedCacheKey, result);

    return result;
  }

  private buildEmbeddingMaps(indexProducts: BookstoreIndexProduct[]): {
    author: Map<string, Float32Array>;
    category: Map<string, Float32Array>;
    description: Map<string, Float32Array>;
  } {
    const author = new Map<string, Float32Array>();
    const category = new Map<string, Float32Array>();
    const description = new Map<string, Float32Array>();
    for (const p of indexProducts) {
      author.set(p.productId, p.authorEmbedding);
      category.set(p.productId, p.categoryEmbedding);
      description.set(p.productId, p.descriptionEmbedding);
    }
    return { author, category, description };
  }

  private mergeUniqueProducts(
    primary: ShopifyProductSummary[],
    extra: ShopifyProductSummary[],
  ): ShopifyProductSummary[] {
    const byId = new Map<string, ShopifyProductSummary>();
    for (const p of primary) byId.set(p.productId, p);
    for (const p of extra) {
      if (!byId.has(p.productId)) byId.set(p.productId, p);
    }
    return [...byId.values()];
  }

  private prioritizeLocalHits(
    products: ShopifyProductSummary[],
    localIds: string[],
  ): ShopifyProductSummary[] {
    if (localIds.length === 0) return products;
    const order = new Map(localIds.map((id, i) => [id, i]));
    return [...products].sort((a, b) => {
      const ai = order.get(a.productId) ?? 999;
      const bi = order.get(b.productId) ?? 999;
      return ai - bi;
    });
  }

  /** PostgreSQL productCache index only — no Redis cache read, no Shopify live. */
  async searchIndexedOnly(input: {
    tenantId: string;
    agentId: string;
    query: string;
    limit: number;
    shopDomain?: string | null;
  }): Promise<BookstoreVoiceSearchResult> {
    const started = Date.now();
    const productSearchInputRaw = input.query.trim();
    if (!productSearchInputRaw) {
      return this.emptyQueryResult();
    }

    const { cleanedQuery, probableTitle } = cleanVoiceProductQuery(productSearchInputRaw);
    const { products: indexProducts, embeddings } = await this.index.getIndex(
      input.tenantId,
      input.agentId,
      input.shopDomain,
    );

    const localFirst = await this.tryLocalCatalogOnlySearch({
      tenantId: input.tenantId,
      agentId: input.agentId,
      shopDomain: input.shopDomain,
      indexProducts,
      embeddings,
      productSearchInputRaw,
      probableTitle,
      cleanedQuery,
      limit: input.limit,
    });

    const searchVoiceLog = {
      ...this.emptyLog(productSearchInputRaw),
      cleanedQuery,
      probableTitle,
      productsReturned: localFirst.products.length,
      productsReturnedCount: localFirst.products.length,
      productsAfterRanking: localFirst.products.length,
      topProduct: localFirst.products[0]?.title ?? null,
      topProductTitle: localFirst.products[0]?.title ?? null,
      topScore: localFirst.bestScore,
      topMatchReason: localFirst.products[0]?.matchReason ?? 'local_index',
      rankedProducts: localFirst.products.map((p) => ({
        title: p.title,
        score: p.relevanceScore ?? localFirst.bestScore,
        matchReason: p.matchReason ?? 'local_index',
      })),
      lowConfidenceSearch: localFirst.bestScore < LOCAL_SEARCH_SKIP_SHOPIFY_MIN_SCORE,
      bookstoreSearch: {
        fuzzySearchActivated: true,
        semanticSearchUsed: indexProducts.length > 0,
        cacheHit: false,
        memoryHit: false,
        redisHit: false,
        searchLatencyMs: Date.now() - started,
        fallbackStage: 'fuzzy_local' as BookstoreSearchFallbackStage,
        indexSize: indexProducts.length,
        topResultConfidence: localFirst.bestScore,
        confidenceTier:
          localFirst.bestScore >= LOCAL_SEARCH_SKIP_SHOPIFY_MIN_SCORE
            ? ('HIGH' as BookstoreConfidenceTier)
            : localFirst.bestScore >= 550
              ? ('MEDIUM' as BookstoreConfidenceTier)
              : ('LOW' as BookstoreConfidenceTier),
        recommendedBooks: localFirst.products.map((p) => ({
          title: p.title,
          score: p.relevanceScore ?? localFirst.bestScore,
          matchReason: p.matchReason ?? 'local_index',
          vendor: p.vendor,
        })),
        rankingDiagnostics: [],
        debounced: false,
        parallelShopifyQueries: 0,
      },
    };

    return {
      ok: localFirst.products.length > 0,
      products: localFirst.products,
      searchVoiceLog,
    };
  }

  /**
   * Search in-memory productCache index before any live Shopify GraphQL call.
   */
  private async tryLocalCatalogOnlySearch(args: {
    tenantId: string;
    agentId: string;
    shopDomain?: string | null;
    indexProducts: BookstoreIndexProduct[];
    embeddings: Map<string, Float32Array>;
    productSearchInputRaw: string;
    probableTitle: string;
    cleanedQuery: string;
    limit: number;
  }): Promise<{ sufficient: boolean; products: ShopifyProductSummary[]; bestScore: number }> {
    if (args.indexProducts.length === 0) {
      return { sufficient: false, products: [], bestScore: 0 };
    }

    const queryKey = args.probableTitle || args.cleanedQuery || args.productSearchInputRaw;
    const localIds = this.index.localCandidateIds(args.indexProducts, queryKey);
    const catalogResult = retrieveFromCatalogIndex(
      args.indexProducts,
      args.productSearchInputRaw,
      queryKey,
      20,
    );
    const hydrateIds = catalogResult.candidates.slice(0, 12).map((c) => c.productId);
    const hydrated = await this.index.hydrateProducts(
      args.tenantId,
      args.agentId,
      args.shopDomain,
      hydrateIds.length > 0 ? hydrateIds : localIds.slice(0, 12),
    );
    let boosted = this.prioritizeLocalHits(hydrated, localIds.length > 0 ? localIds : hydrateIds);
    if (boosted.length === 0) {
      return { sufficient: false, products: [], bestScore: 0 };
    }

    const embeddingMaps = this.buildEmbeddingMaps(args.indexProducts);
    const ranking = rankBookstoreProducts({
      queryOriginal: args.productSearchInputRaw,
      probableTitle: queryKey,
      products: boosted,
      maxResults: Math.min(5, Math.max(1, args.limit)),
      indexEmbeddings: args.embeddings,
      indexAuthorEmbeddings: embeddingMaps.author,
      indexCategoryEmbeddings: embeddingMaps.category,
      indexDescriptionEmbeddings: embeddingMaps.description,
      catalogSemanticRecovery: true,
    });

    const products: ShopifyProductSummary[] = [];
    for (const r of ranking.ranked) {
      const full = boosted.find((b) => b.productId === r.productId);
      if (!full) continue;
      products.push({
        ...full,
        relevanceScore: r.relevanceScore,
        matchReason: r.matchReason,
      });
    }

    const sufficient =
      products.length > 0 && ranking.bestScore >= LOCAL_SEARCH_SKIP_SHOPIFY_MIN_SCORE;
    return { sufficient, products, bestScore: ranking.bestScore };
  }

  private emptyQueryResult(): BookstoreVoiceSearchResult {
    const searchVoiceLog = this.emptyLog('');
    return {
      ok: true,
      products: [],
      voiceSummary: `I didn't catch what to search. Could you say the product name again, or spell it?`,
      searchVoiceLog,
    };
  }

  private emptyLog(raw: string): ShopifyProductSearchVoiceLog {
    return {
      productSearchInputRaw: raw,
      cleanedQuery: '',
      probableTitle: '',
      shopifyQueriesTried: [],
      productsReturned: 0,
      productsReturnedCount: 0,
      productsAfterRanking: 0,
      rankedProducts: [],
      topProduct: null,
      topProductTitle: null,
      topScore: null,
      topMatchReason: 'empty_query',
      lowConfidenceSearch: true,
      finalVoiceSummary: '',
    };
  }

  private wrapCacheResult(
    hit: BookstoreVoiceSearchResult,
    productSearchInputRaw: string,
    started: number,
    cacheHit: boolean,
    debounced: boolean,
    lookup?: { cacheLookupMs?: number; memoryHit?: boolean; redisHit?: boolean },
  ): BookstoreVoiceSearchResult {
    return {
      ...hit,
      searchVoiceLog: {
        ...(hit.searchVoiceLog ?? this.emptyLog(productSearchInputRaw)),
        bookstoreSearch: this.diagFromCache(hit, started, cacheHit, debounced, lookup),
      },
    };
  }

  private diagFromCache(
    hit: BookstoreVoiceSearchResult,
    started: number,
    cacheHit: boolean,
    debounced: boolean,
    lookup?: { cacheLookupMs?: number; memoryHit?: boolean; redisHit?: boolean },
  ): BookstoreSearchDiagnostics {
    const prev = hit.searchVoiceLog?.bookstoreSearch;
    return {
      fuzzySearchActivated: prev?.fuzzySearchActivated ?? false,
      semanticSearchUsed: prev?.semanticSearchUsed ?? false,
      cacheHit,
      memoryHit: lookup?.memoryHit ?? cacheHit,
      redisHit: lookup?.redisHit ?? false,
      cacheLookupMs: lookup?.cacheLookupMs,
      searchLatencyMs: Date.now() - started,
      confidenceTier: (hit.searchVoiceLog?.confidenceTier as BookstoreConfidenceTier) ?? 'MEDIUM',
      topResultConfidence: hit.products?.[0]?.relevanceScore ?? prev?.topResultConfidence ?? 0,
      recommendedBooks:
        prev?.recommendedBooks ??
        (hit.products ?? []).map((p) => ({
          title: p.title,
          score: p.relevanceScore ?? 0,
          matchReason: p.matchReason ?? 'cache',
          vendor: p.vendor,
        })),
      rankingDiagnostics: prev?.rankingDiagnostics ?? [],
      debounced,
      parallelShopifyQueries: 0,
      indexSize: prev?.indexSize ?? 0,
    };
  }
}
