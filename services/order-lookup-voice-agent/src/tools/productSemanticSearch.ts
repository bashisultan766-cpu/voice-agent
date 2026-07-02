import OpenAI from "openai";
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { normalizeSearchText, scoreTitleMatch } from "../utils/productSearchNormalize.js";
import type { StructuredProduct } from "../types/product.js";

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

/** Layer 3 — semantic similarity search via OpenAI embeddings (typos, partial titles). */
export async function semanticProductSearch(
  query: string,
  catalog: StructuredProduct[],
  topK = 3,
): Promise<StructuredProduct[]> {
  const q = query.trim();
  if (!q || catalog.length === 0) return [];

  try {
    await ensureVectorIndex(catalog);
    const [queryVector] = await embedTexts([q]);

    const ranked = vectorIndex
      .map((entry) => ({
        productId: entry.productId,
        score: cosineSimilarity(queryVector, entry.vector),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    const byId = new Map(catalog.map((p) => [p.id, p]));
    return ranked.map((r) => byId.get(r.productId)).filter(Boolean) as StructuredProduct[];
  } catch (err) {
    logger.warn("semantic_search_fallback_to_token", {
      error: err instanceof Error ? err.message : String(err),
    });
    return tokenFallbackSearch(q, catalog, topK);
  }
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
