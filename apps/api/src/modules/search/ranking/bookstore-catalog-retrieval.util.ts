import type { BookstoreIndexProduct } from '../types/bookstore-search.types';
import {
  buildAuthorEmbedding,
  buildCategoryEmbedding,
  buildDescriptionEmbedding,
  buildTitleEmbedding,
  cosineSimilarity,
} from './bookstore-semantic.util';
import {
  expandQueryTokens,
  levenshteinSimilarity,
  normalizeBookTitleForSearch,
  tokenOverlapScore,
} from './bookstore-title-normalizer.util';

/** Pipeline stage that produced the winning catalog candidate. */
export type CatalogFallbackStage =
  | 'exact_title'
  | 'fuzzy_local'
  | 'semantic_vector'
  | 'author_category'
  | 'combined'
  | 'none';

export interface CatalogRetrievalCandidate {
  productId: string;
  title: string;
  vendor: string | null;
  score: number;
  fallbackStage: CatalogFallbackStage;
  semanticConfidence: number;
  semanticMatchReason: string;
  rerankScore: number;
}

export interface CatalogRetrievalResult {
  candidates: CatalogRetrievalCandidate[];
  semanticSearchActivated: boolean;
  vectorLatencyMs: number;
  fallbackStage: CatalogFallbackStage;
  semanticConfidence: number;
  semanticMatchReason: string | null;
}

const SEMANTIC_MIN = 0.28;
const SEMANTIC_STRONG = 0.42;

function detectAuthorInQuery(query: string): string | null {
  const m = query.match(/\bby\s+([a-z][a-z\s.'-]{2,40})/i);
  return m ? normalizeBookTitleForSearch(m[1]!) : null;
}

function combinedSemanticScore(
  queryTitleEmb: Float32Array,
  queryAuthorEmb: Float32Array,
  product: BookstoreIndexProduct,
): { score: number; reason: string } {
  const titleSim = cosineSimilarity(queryTitleEmb, product.embedding);
  const authorSim = cosineSimilarity(queryAuthorEmb, product.authorEmbedding);
  const catSim = cosineSimilarity(queryTitleEmb, product.categoryEmbedding);
  const descSim = product.descriptionEmbedding
    ? cosineSimilarity(queryTitleEmb, product.descriptionEmbedding)
    : 0;
  const blended = titleSim * 0.5 + authorSim * 0.2 + catSim * 0.15 + descSim * 0.15;
  let reason = 'semantic_title';
  if (authorSim > titleSim && authorSim > 0.35) reason = 'semantic_author';
  else if (descSim > titleSim && descSim > 0.32) reason = 'semantic_description';
  else if (catSim > titleSim && catSim > 0.32) reason = 'semantic_category';
  return { score: blended, reason };
}

/**
 * Multi-stage catalog retrieval when Shopify keyword search is empty or weak.
 * Stages: exact title → fuzzy token/Levenshtein → semantic vectors → author/category.
 */
export function retrieveFromCatalogIndex(
  index: BookstoreIndexProduct[],
  queryOriginal: string,
  probableTitle: string,
  limit = 25,
): CatalogRetrievalResult {
  const started = Date.now();
  if (index.length === 0) {
    return {
      candidates: [],
      semanticSearchActivated: false,
      vectorLatencyMs: Date.now() - started,
      fallbackStage: 'none',
      semanticConfidence: 0,
      semanticMatchReason: null,
    };
  }

  const queryNorm = normalizeBookTitleForSearch(probableTitle || queryOriginal);
  const queryTokens = expandQueryTokens(probableTitle || queryOriginal);
  const queryTitleEmb = buildTitleEmbedding(probableTitle || queryOriginal);
  const queryAuthorPhrase = detectAuthorInQuery(queryOriginal);
  const queryAuthorEmb = buildAuthorEmbedding(queryAuthorPhrase ?? '');

  const byId = new Map<string, CatalogRetrievalCandidate>();

  const upsert = (c: CatalogRetrievalCandidate) => {
    const prev = byId.get(c.productId);
    if (!prev || c.rerankScore > prev.rerankScore) byId.set(c.productId, c);
  };

  for (const p of index) {
    if (p.normalizedTitle === queryNorm) {
      upsert({
        productId: p.productId,
        title: p.title,
        vendor: p.vendor,
        score: 1000,
        fallbackStage: 'exact_title',
        semanticConfidence: 1,
        semanticMatchReason: 'exact_title_match',
        rerankScore: 1000,
      });
      continue;
    }
    if (queryNorm.length > 8 && p.normalizedTitle.includes(queryNorm)) {
      upsert({
        productId: p.productId,
        title: p.title,
        vendor: p.vendor,
        score: 920,
        fallbackStage: 'exact_title',
        semanticConfidence: 0.95,
        semanticMatchReason: 'substring_title_match',
        rerankScore: 920,
      });
    }
  }

  for (const p of index) {
    const overlap = tokenOverlapScore(queryTokens, p.normalizedTitle);
    const lev = levenshteinSimilarity(queryNorm, p.normalizedTitle);
    const fuzzyScore = Math.round(overlap * 400 + lev * 350);
    if (fuzzyScore >= 180 || (overlap >= 0.45 && lev >= 0.55)) {
      upsert({
        productId: p.productId,
        title: p.title,
        vendor: p.vendor,
        score: fuzzyScore,
        fallbackStage: 'fuzzy_local',
        semanticConfidence: lev,
        semanticMatchReason:
          lev >= 0.65 ? 'fuzzy_levenshtein_title' : overlap >= 0.5 ? 'fuzzy_token_overlap' : 'fuzzy_combined',
        rerankScore: fuzzyScore,
      });
    }
  }

  let bestSemantic = 0;
  let bestSemanticReason: string | null = null;

  for (const p of index) {
    const { score: sem, reason } = combinedSemanticScore(queryTitleEmb, queryAuthorEmb, p);
    if (sem >= SEMANTIC_MIN) {
      const semScore = Math.round(sem * 800);
      if (sem > bestSemantic) {
        bestSemantic = sem;
        bestSemanticReason = reason;
      }
      upsert({
        productId: p.productId,
        title: p.title,
        vendor: p.vendor,
        score: semScore,
        fallbackStage: 'semantic_vector',
        semanticConfidence: sem,
        semanticMatchReason: reason,
        rerankScore: semScore,
      });
    }
  }

  if (queryAuthorPhrase) {
    const authorNorm = queryAuthorPhrase;
    for (const p of index) {
      const vendorNorm = p.normalizedAuthor;
      if (!vendorNorm) continue;
      const lev = levenshteinSimilarity(authorNorm, vendorNorm);
      const authorSem = cosineSimilarity(queryAuthorEmb, p.authorEmbedding);
      if (lev >= 0.7 || authorSem >= 0.4) {
        const score = Math.round(Math.max(lev, authorSem) * 700);
        upsert({
          productId: p.productId,
          title: p.title,
          vendor: p.vendor,
          score,
          fallbackStage: 'author_category',
          semanticConfidence: authorSem,
          semanticMatchReason: 'author_vendor_match',
          rerankScore: score,
        });
      }
    }
  }

  const categoryEmb = buildCategoryEmbedding(null, queryNorm);
  for (const p of index) {
    const catSim = cosineSimilarity(categoryEmb, p.categoryEmbedding);
    if (catSim >= 0.38) {
      const score = Math.round(catSim * 500);
      upsert({
        productId: p.productId,
        title: p.title,
        vendor: p.vendor,
        score,
        fallbackStage: 'author_category',
        semanticConfidence: catSim,
        semanticMatchReason: 'category_tags_match',
        rerankScore: score,
      });
    }
  }

  const sorted = [...byId.values()].sort((a, b) => b.rerankScore - a.rerankScore).slice(0, limit);
  const top = sorted[0];
  const semanticSearchActivated =
    bestSemantic >= SEMANTIC_MIN ||
    sorted.some((c) => c.fallbackStage === 'semantic_vector' && c.semanticConfidence >= SEMANTIC_STRONG);

  const dominantStage: CatalogFallbackStage =
    top?.fallbackStage ?? (sorted.length > 0 ? 'combined' : 'none');

  return {
    candidates: sorted,
    semanticSearchActivated,
    vectorLatencyMs: Date.now() - started,
    fallbackStage: sorted.length > 1 ? 'combined' : dominantStage,
    semanticConfidence: top?.semanticConfidence ?? bestSemantic,
    semanticMatchReason: top?.semanticMatchReason ?? bestSemanticReason,
  };
}
