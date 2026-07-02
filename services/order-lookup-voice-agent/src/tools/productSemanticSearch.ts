import OpenAI from "openai";
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  normalizeSearchText,
  rankLiveProducts,
  scoreLiveProduct,
  scoreTitleMatch,
} from "../utils/productSearchNormalize.js";
import type { StructuredProduct } from "../types/product.js";

const MIN_LIVE_RESULTS = 3;
const SEMANTIC_SIMILARITY_THRESHOLD = 0.28;

interface ProductVector {
  productId: string;
  title: string;
  vector: number[];
}

let embeddingClient: OpenAI | null = null;
let vectorIndex: ProductVector[] = [];
let indexCatalogHash = "";

function getClient(): OpenAI {
  if (!embeddingClient) {
    embeddingClient = new OpenAI({
      apiKey: getConfig().OPENAI_API_KEY,
      timeout: getConfig().OPENAI_TIMEOUT_MS,
    });
  }
  return embeddingClient;
}

function catalogHash(products: StructuredProduct[]): string {
  return products.map((p) => `${p.id}:${p.title}`).join("|").slice(0, 4000);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const response = await getClient().embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
  });
  return response.data.map((d) => d.embedding);
}

async function ensureVectorIndex(products: StructuredProduct[]): Promise<void> {
  const hash = catalogHash(products);
  if (vectorIndex.length > 0 && indexCatalogHash === hash) return;

  const titles = products.map((p) => p.title);
  const batchSize = 64;
  const vectors: ProductVector[] = [];

  for (let i = 0; i < titles.length; i += batchSize) {
    const slice = titles.slice(i, i + batchSize);
    const embeddings = await embedTexts(slice);
    for (let j = 0; j < slice.length; j++) {
      const product = products[i + j];
      vectors.push({
        productId: product.id,
        title: product.title,
        vector: embeddings[j],
      });
    }
  }

  vectorIndex = vectors;
  indexCatalogHash = hash;
  logger.info("product_embedding_index_built", { count: vectorIndex.length });
}

/**
 * Semantic rerank on LIVE Shopify products only — fallback when live fetch returns <3.
 * Never invents products outside the live pool.
 */
export async function semanticRerankLiveProducts(
  query: string,
  liveProducts: StructuredProduct[],
  topK = 5,
): Promise<StructuredProduct[]> {
  const q = query.trim();
  if (!q || liveProducts.length === 0) return [];

  try {
    const texts = [q, ...liveProducts.map((p) => p.title)];
    const vectors = await embedTexts(texts);
    const queryVector = vectors[0];

    const ranked = liveProducts
      .map((product, index) => {
        const similarity = cosineSimilarity(queryVector, vectors[index + 1]);
        const semanticBonus = similarity >= SEMANTIC_SIMILARITY_THRESHOLD ? 1 : 0;
        return {
          product,
          score: scoreLiveProduct(product, q) + semanticBonus,
          similarity,
        };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.similarity - a.similarity)
      .slice(0, topK);

    return ranked.map((x) => x.product);
  } catch (err) {
    logger.warn("semantic_rerank_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return rankLiveProducts(liveProducts, q).slice(0, topK);
  }
}

/** Apply semantic rerank only when Shopify live fetch returned fewer than 3 products. */
export async function applySemanticFallbackIfNeeded(
  query: string,
  liveProducts: StructuredProduct[],
): Promise<{ products: StructuredProduct[]; usedSemantic: boolean }> {
  const ranked = rankLiveProducts(liveProducts, query);
  if (liveProducts.length >= MIN_LIVE_RESULTS) {
    return { products: ranked.slice(0, 5), usedSemantic: false };
  }

  if (liveProducts.length === 0) {
    return { products: [], usedSemantic: false };
  }

  const reranked = await semanticRerankLiveProducts(query, liveProducts, 5);
  return {
    products: reranked.length > 0 ? reranked : ranked.slice(0, 5),
    usedSemantic: true,
  };
}

/** @deprecated Use semanticRerankLiveProducts on live Shopify results only. */
export async function semanticProductSearch(
  query: string,
  catalog: StructuredProduct[],
  topK = 3,
): Promise<StructuredProduct[]> {
  return semanticRerankLiveProducts(query, catalog, topK);
}

/** Token-scored fallback when embeddings unavailable. */
export function tokenFallbackSearch(
  query: string,
  catalog: StructuredProduct[],
  topK = 3,
): StructuredProduct[] {
  const normalizedQuery = normalizeSearchText(query);
  return [...catalog]
    .map((p) => ({
      product: p,
      score: scoreTitleMatch(p.title, normalizedQuery),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.product);
}

export function clearSemanticIndex(): void {
  vectorIndex = [];
  indexCatalogHash = "";
}
