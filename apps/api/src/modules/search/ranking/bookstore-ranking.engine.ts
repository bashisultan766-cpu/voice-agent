import type { RankableCatalogProduct } from '../../agents/shopify-product-relevance.util';
import {
  PRODUCT_SEARCH_CONFIDENT_MIN_SCORE,
  PRODUCT_SEARCH_CONFIRM_MIN_SCORE,
  PRODUCT_SEARCH_MIN_CONSIDER_SCORE,
  scoreCatalogProduct,
} from '../../agents/shopify-product-relevance.util';
import type { BookstoreConfidenceTier, BookstoreRankedProduct } from '../types/bookstore-search.types';
import { buildTitleEmbedding, cosineSimilarity } from './bookstore-semantic.util';
import { deriveSeriesKey, extractVolumeNumber, seriesMatchBoost } from './bookstore-series.util';
import {
  expandQueryTokens,
  levenshteinSimilarity,
  normalizeBookTitleForSearch,
  tokenOverlapScore,
} from './bookstore-title-normalizer.util';

export interface BookstoreRankingInput {
  queryOriginal: string;
  probableTitle: string;
  products: RankableCatalogProduct[];
  maxResults: number;
  queryEmbedding?: Float32Array;
  indexEmbeddings?: Map<string, Float32Array>;
}

export interface BookstoreRankingOutput {
  ranked: BookstoreRankedProduct[];
  rankedForLog: Array<{ title: string; score: number; matchReason: string }>;
  bestScore: number;
  bestReason: string | null;
  lowConfidence: boolean;
  productsAfterRanking: number;
  topProduct: string | null;
  confidenceTier: BookstoreConfidenceTier;
  diagnostics: Array<{
    title: string;
    tokenOverlap: number;
    levenshtein: number;
    semantic: number;
    authorBoost: number;
  }>;
  fuzzySearchActivated: boolean;
  semanticSearchUsed: boolean;
}

const POPULAR_SERIES_HINTS: Record<string, string[]> = {
  'dark tower': ['gunslinger', 'drawing of the three', 'waste lands'],
  'harry potter': ['sorcerer', 'stone', 'philosopher', 'chamber', 'azkaban'],
};

function confidenceTierFromScore(score: number): BookstoreConfidenceTier {
  if (score >= PRODUCT_SEARCH_CONFIDENT_MIN_SCORE) return 'HIGH';
  if (score >= PRODUCT_SEARCH_CONFIRM_MIN_SCORE) return 'MEDIUM';
  return 'LOW';
}

function detectAuthorInQuery(query: string): string | null {
  const m = query.match(/\bby\s+([a-z][a-z\s.'-]{2,40})/i);
  return m ? normalizeBookTitleForSearch(m[1]!) : null;
}

function authorBoost(queryAuthor: string | null, vendor: string | null | undefined): number {
  if (!queryAuthor || !vendor) return 0;
  const v = normalizeBookTitleForSearch(vendor);
  if (v.includes(queryAuthor) || queryAuthor.includes(v)) return 80;
  const sim = levenshteinSimilarity(queryAuthor, v);
  return sim >= 0.72 ? Math.round(sim * 50) : 0;
}

function popularSeriesHintBoost(queryNorm: string, titleNorm: string): number {
  for (const [series, hints] of Object.entries(POPULAR_SERIES_HINTS)) {
    if (!queryNorm.includes(series)) continue;
    if (hints.some((h) => titleNorm.includes(h))) return 70;
    if (titleNorm.includes(series)) return 40;
  }
  return 0;
}

export function rankBookstoreProducts(input: BookstoreRankingInput): BookstoreRankingOutput {
  const queryNorm = normalizeBookTitleForSearch(input.probableTitle || input.queryOriginal);
  const queryTokens = expandQueryTokens(input.probableTitle || input.queryOriginal);
  const querySeries = deriveSeriesKey(input.probableTitle || input.queryOriginal);
  const queryVolume = extractVolumeNumber(input.queryOriginal);
  const queryAuthor = detectAuthorInQuery(input.queryOriginal);
  const queryEmbedding = input.queryEmbedding ?? buildTitleEmbedding(input.probableTitle || input.queryOriginal);

  let fuzzySearchActivated = false;
  let semanticSearchUsed = false;

  const scored = input.products.map((p) => {
    const legacy = scoreCatalogProduct(input.queryOriginal, input.probableTitle, p);
    const titleNorm = normalizeBookTitleForSearch(p.title);
    const overlap = tokenOverlapScore(queryTokens, titleNorm);
    const lev = levenshteinSimilarity(queryNorm, titleNorm);
    const productEmbedding =
      input.indexEmbeddings?.get((p as { productId?: string }).productId ?? p.title) ??
      buildTitleEmbedding(p.title);
    const semantic = cosineSimilarity(queryEmbedding, productEmbedding);
    if (semantic > 0.35) semanticSearchUsed = true;

    const seriesKey = deriveSeriesKey(p.title);
    const volumeNumber = extractVolumeNumber(p.title);
    const seriesBoost = seriesMatchBoost(querySeries, seriesKey, queryVolume, volumeNumber);
    const authBoost = authorBoost(queryAuthor, p.vendor);
    const hintBoost = popularSeriesHintBoost(queryNorm, titleNorm);

    const fuzzyComponent = Math.round(overlap * 180 + lev * 120);
    if (overlap < 0.5 && lev < 0.55 && legacy.score < PRODUCT_SEARCH_MIN_CONSIDER_SCORE) {
      fuzzySearchActivated = true;
    }

    const semanticBoost = Math.round(semantic * 120);
    const relevanceScore = Math.min(
      1000,
      Math.max(
        legacy.score,
        Math.round(
          legacy.score +
            fuzzyComponent * 0.35 +
            semanticBoost * 0.25 +
            seriesBoost * 0.5 +
            authBoost * 0.4 +
            hintBoost * 0.3,
        ),
      ),
    );
    const matchReason =
      legacy.score >= 800
        ? legacy.matchReason
        : seriesBoost > 0
          ? 'series_volume_match'
          : authBoost > 0
            ? 'author_boost'
            : semantic > 0.45
              ? 'semantic_similarity'
              : lev > 0.7
                ? 'fuzzy_title_levenshtein'
                : overlap >= 0.6
                  ? 'token_overlap'
                  : legacy.matchReason;

    return {
      ...(p as RankableCatalogProduct & { productId?: string }),
      relevanceScore,
      matchReason,
      compositeScore: relevanceScore,
      confidenceTier: confidenceTierFromScore(relevanceScore),
      seriesKey,
      volumeNumber,
      _diag: { tokenOverlap: overlap, levenshtein: lev, semantic, authorBoost: authBoost },
    };
  });

  scored.sort((a, b) => b.relevanceScore - a.relevanceScore || a.title.localeCompare(b.title));

  const diagnostics = scored.slice(0, 12).map((p) => {
    const d = (p as { _diag?: { tokenOverlap: number; levenshtein: number; semantic: number; authorBoost: number } })._diag;
    return {
      title: p.title,
      tokenOverlap: d?.tokenOverlap ?? 0,
      levenshtein: d?.levenshtein ?? 0,
      semantic: d?.semantic ?? 0,
      authorBoost: d?.authorBoost ?? 0,
    };
  });

  const productsAfterRanking = scored.filter(
    (p) => p.relevanceScore >= PRODUCT_SEARCH_MIN_CONSIDER_SCORE,
  ).length;

  const rankedForLog = scored
    .filter((p) => p.relevanceScore > 0)
    .slice(0, 15)
    .map((p) => ({ title: p.title, score: p.relevanceScore, matchReason: p.matchReason }));

  const considered = scored.filter((p) => p.relevanceScore >= PRODUCT_SEARCH_MIN_CONSIDER_SCORE);
  const confidentBand = considered.filter((p) => p.relevanceScore >= PRODUCT_SEARCH_CONFIRM_MIN_SCORE);
  const take = Math.max(1, Math.min(5, input.maxResults));
  const capped = confidentBand.slice(0, take);

  const bestScore = scored[0]?.relevanceScore ?? 0;
  const bestReason = scored[0]?.matchReason ?? null;
  const lowConfidence = bestScore < PRODUCT_SEARCH_CONFIRM_MIN_SCORE;
  const topProduct = scored[0]?.title ?? null;
  const confidenceTier = confidenceTierFromScore(bestScore);

  const ranked: BookstoreRankedProduct[] = capped.map((p) => {
    const row = p as unknown as RankableCatalogProduct & {
      productId?: string;
      tags?: string[];
      isbn?: string | null;
      variants?: BookstoreRankedProduct['variants'];
    };
    return {
      productId: row.productId ?? '',
      title: row.title,
      handle: row.handle ?? null,
      vendor: row.vendor ?? null,
      productType: row.productType ?? null,
      tags: row.tags,
      isbn: row.isbn ?? null,
      variants: row.variants ?? [],
      relevanceScore: p.relevanceScore,
      matchReason: p.matchReason,
      compositeScore: p.compositeScore,
      confidenceTier: p.confidenceTier,
      seriesKey: p.seriesKey,
      volumeNumber: p.volumeNumber,
    };
  });

  return {
    ranked,
    rankedForLog,
    bestScore,
    bestReason,
    lowConfidence,
    productsAfterRanking,
    topProduct,
    confidenceTier,
    diagnostics,
    fuzzySearchActivated,
    semanticSearchUsed,
  };
}

/** Similar titles when exact match is weak — same author, series, or semantic neighbors. */
export function pickSimilarRecommendations(
  query: string,
  allRanked: Array<{ title: string; vendor?: string | null; relevanceScore: number; matchReason: string; seriesKey?: string | null }>,
  limit = 3,
): Array<{ title: string; score: number; matchReason: string; vendor?: string | null }> {
  const querySeries = deriveSeriesKey(query);
  const queryAuthor = detectAuthorInQuery(query);
  const pool = allRanked.filter((p) => p.relevanceScore >= 400);
  const similar = pool.filter((p) => {
    if (querySeries && p.seriesKey && (p.seriesKey.includes(querySeries) || querySeries.includes(p.seriesKey))) {
      return true;
    }
    if (queryAuthor && p.vendor && normalizeBookTitleForSearch(p.vendor).includes(queryAuthor)) return true;
    return p.relevanceScore >= 550 && p.matchReason.includes('semantic');
  });
  return similar.slice(0, limit).map((p) => ({
    title: p.title,
    score: p.relevanceScore,
    matchReason: p.matchReason,
    vendor: p.vendor,
  }));
}
