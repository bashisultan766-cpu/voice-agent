import { logger } from "../utils/logger.js";
import { assertToolExecutionAllowed } from "../guards/toolExecutionGuard.js";
import { extractIsbnFromSpeech, scoreTitleMatch, tagOverlapScore } from "../utils/productSearchNormalize.js";
import { resetShopifyScopeCheck, ensureShopifyProductScopes } from "./shopifyScopeCheck.js";
import {
  liveFetchProductById,
  liveSearchMulti,
} from "./shopifyLiveSearch.js";
import {
  STORE_NOT_FOUND_MESSAGE,
  truthSearchByCategory,
  truthSearchByIsbn,
  truthSearchByTitle,
} from "./shopifyTruthSearch.js";
import type {
  InventoryStatus,
  ProductSearchResult,
  StructuredProduct,
} from "../types/product.js";

export { STORE_NOT_FOUND_MESSAGE, extractIsbnFromSpeech };
export { normalizeIsbn } from "../utils/productSearchNormalize.js";

function productInStock(p: StructuredProduct): boolean {
  return p.variants.some((v) => v.inStock);
}

function dedupeProducts(products: StructuredProduct[]): StructuredProduct[] {
  const seen = new Set<string>();
  const out: StructuredProduct[] = [];
  for (const p of products) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

function toSearchResult(
  products: StructuredProduct[],
  query: string,
  apiErrorMessage?: string,
): ProductSearchResult {
  if (apiErrorMessage) {
    return { status: "api_error", products: [], query, message: apiErrorMessage };
  }
  const ranked = products.slice(0, 5);
  return {
    status: ranked.length ? "found" : "not_found",
    products: ranked,
    query,
    message: ranked.length === 0 ? STORE_NOT_FOUND_MESSAGE : undefined,
  };
}

/** Live Shopify title search — truth engine only, no embeddings. */
export async function searchProductByTitle(query: string): Promise<ProductSearchResult> {
  assertToolExecutionAllowed("searchProductByTitle");
  const q = query.trim();
  if (!q) {
    return { status: "not_found", products: [], query: q, message: STORE_NOT_FOUND_MESSAGE };
  }

  try {
    const ranked = await truthSearchByTitle(q);
    return toSearchResult(ranked, q);
  } catch (err) {
    logger.error("title_search_failed", {
      query: q,
      error: err instanceof Error ? err.message : String(err),
    });
    return toSearchResult([], q, "Product search is temporarily unavailable");
  }
}

/** Live ISBN lookup — truth engine only. */
export async function searchProductByISBN(isbn: string): Promise<ProductSearchResult> {
  assertToolExecutionAllowed("searchProductByISBN");
  try {
    await ensureShopifyProductScopes();
    const ranked = await truthSearchByIsbn(isbn);
    return toSearchResult(ranked, isbn);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/read_products/i.test(message)) {
      return toSearchResult([], isbn, "ISBN lookup is temporarily unavailable");
    }
    logger.error("isbn_search_failed", { isbn, error: message });
    return toSearchResult([], isbn, "ISBN lookup is temporarily unavailable");
  }
}

function scoreSimilarity(source: StructuredProduct, candidate: StructuredProduct): number {
  if (source.id === candidate.id) return -1;

  let score = 0;
  if (source.productType && candidate.productType === source.productType) score += 3;
  if (source.vendor && candidate.vendor === source.vendor) score += 2;
  score += tagOverlapScore(source.tags, candidate.tags);
  score += scoreTitleMatch(candidate.title, source.title) * 0.5;
  if (productInStock(candidate)) score += 1;
  return score;
}

/** Similar products from live Shopify catalog only. */
export async function getSimilarProducts(productId: string): Promise<ProductSearchResult> {
  assertToolExecutionAllowed("getSimilarProducts");
  try {
    const source = await liveFetchProductById(productId);
    if (!source) {
      return {
        status: "not_found",
        products: [],
        query: `similar:${productId}`,
        message: STORE_NOT_FOUND_MESSAGE,
      };
    }

    const queries = [
      `product_type:'${source.productType}'`,
      `vendor:'${source.vendor}'`,
      ...source.tags.slice(0, 3).map((tag) => `tag:'${tag}'`),
    ].filter(Boolean);

    let live = await liveSearchMulti(queries);
    live = live.filter((p) => p.id !== source.id);

    if (live.length < 10 && source.productType) {
      const broader = await truthSearchByCategory(source.productType);
      live = dedupeProducts([...live, ...broader.filter((p) => p.id !== source.id)]);
    }

    const similar = live
      .map((p) => ({ p, score: scoreSimilarity(source, p) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.p);

    const outOfStock = !productInStock(source);
    const products = (outOfStock ? similar.filter(productInStock) : similar).slice(0, 5);

    return {
      status: products.length ? "found" : "not_found",
      products,
      query: `similar:${productId}`,
      message: products.length === 0 ? STORE_NOT_FOUND_MESSAGE : undefined,
    };
  } catch (err) {
    logger.error("similar_search_failed", {
      productId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "api_error", products: [], query: productId };
  }
}

/** Category browse via live Shopify truth search. */
export async function searchProductByCategory(categoryQuery: string): Promise<ProductSearchResult> {
  assertToolExecutionAllowed("searchProductByCategory");
  const q = categoryQuery.trim();
  if (!q) {
    return { status: "not_found", products: [], query: q, message: STORE_NOT_FOUND_MESSAGE };
  }

  try {
    const products = await truthSearchByCategory(q);
    return toSearchResult(products, categoryQuery);
  } catch (err) {
    logger.error("category_search_failed", {
      query: q,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "api_error", products: [], query: categoryQuery };
  }
}

export async function checkInventory(productId: string): Promise<InventoryStatus | null> {
  const product = await liveFetchProductById(productId);
  if (!product) return null;

  const totalQuantity = product.variants.reduce((sum, v) => sum + v.inventoryQuantity, 0);
  return {
    productId,
    title: product.title,
    inStock: productInStock(product),
    totalQuantity,
    variantCount: product.variants.length,
  };
}

export function clearProductCache(): void {
  resetShopifyScopeCheck();
}
