import { logger } from "../utils/logger.js";
import {
  extractIsbnFromSpeech,
  isbnLookupVariants,
  isValidIsbnFormat,
  normalizeIsbn,
  normalizeSearchText,
  productMatchesIsbn,
  rankLiveProducts,
  scoreTitleMatch,
  tagOverlapScore,
  tokenize,
} from "../utils/productSearchNormalize.js";
import { applySemanticFallbackIfNeeded, clearSemanticIndex } from "./productSemanticSearch.js";
import {
  liveFetchProductById,
  liveSearchMulti,
  liveSearchProducts,
} from "./shopifyLiveSearch.js";
import type {
  InventoryStatus,
  ProductSearchResult,
  StructuredProduct,
} from "../types/product.js";

export const STORE_NOT_FOUND_MESSAGE = "I couldn't find it in the store right now";

export { extractIsbnFromSpeech, normalizeIsbn };

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

function buildTitleShopifyQueries(query: string): string[] {
  const q = query.trim();
  if (!q) return [];
  const tokens = tokenize(q);
  const queries = new Set<string>([q, `title:*${q}*`]);
  if (tokens.length >= 2) {
    queries.add(tokens.map((t) => `title:*${t}*`).join(" OR "));
  }
  return [...queries];
}

function buildIsbnShopifyQueries(isbn: string): string[] {
  const queries = new Set<string>();
  for (const variant of isbnLookupVariants(isbn)) {
    queries.add(`barcode:${variant}`);
    queries.add(`sku:${variant}`);
    queries.add(`sku:*${variant}*`);
    queries.add(`barcode:*${variant}*`);
  }
  return [...queries];
}

/** Live Shopify title search — post-fetch normalization + ranking; semantic only if live <3. */
export async function searchProductByTitle(query: string): Promise<ProductSearchResult> {
  const q = query.trim();
  if (!q) {
    return { status: "not_found", products: [], query: q, message: STORE_NOT_FOUND_MESSAGE };
  }

  try {
    const started = Date.now();
    let live = await liveSearchMulti(buildTitleShopifyQueries(q));

    if (live.length < 3) {
      const tokens = tokenize(q);
      if (tokens.length > 0) {
        const broader = await liveSearchMulti(tokens.map((t) => `title:*${t}*`));
        live = dedupeProducts([...live, ...broader]);
      }
    }

    const { products, usedSemantic } = await applySemanticFallbackIfNeeded(q, live);
    const ranked = products.length > 0 ? products : rankLiveProducts(live, q);

    logger.info("title_search_live", {
      query: q,
      liveCount: live.length,
      resultCount: ranked.length,
      usedSemantic,
      elapsedMs: Date.now() - started,
    });

    return {
      status: ranked.length ? "found" : "not_found",
      products: ranked.slice(0, 5),
      query: q,
      message: ranked.length === 0 ? STORE_NOT_FOUND_MESSAGE : undefined,
      usedSemanticFallback: usedSemantic,
    };
  } catch (err) {
    logger.error("title_search_failed", {
      query: q,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: "api_error",
      products: [],
      query: q,
      message: "Product search is temporarily unavailable",
    };
  }
}

/** Live ISBN lookup via SKU, barcode, and metafields — never uses embeddings. */
export async function searchProductByISBN(isbn: string): Promise<ProductSearchResult> {
  const variants = isbnLookupVariants(isbn);
  const primary = variants[0] ?? normalizeIsbn(isbn);
  if (!primary || !isValidIsbnFormat(primary)) {
    return {
      status: "not_found",
      products: [],
      query: isbn,
      message: STORE_NOT_FOUND_MESSAGE,
    };
  }

  try {
    const started = Date.now();
    const live = await liveSearchMulti(buildIsbnShopifyQueries(primary));
    const matched = live.filter((p) =>
      variants.some((variant) => productMatchesIsbn(p, variant)),
    );
    const products = rankLiveProducts(matched, primary, primary).slice(0, 5);

    logger.info("isbn_search_live", {
      isbn: primary,
      liveCount: live.length,
      matchCount: products.length,
      elapsedMs: Date.now() - started,
    });

    return {
      status: products.length ? "found" : "not_found",
      products,
      query: primary,
      message: products.length === 0 ? STORE_NOT_FOUND_MESSAGE : undefined,
    };
  } catch (err) {
    logger.error("isbn_search_failed", {
      isbn: primary,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: "api_error",
      products: [],
      query: primary,
      message: "ISBN lookup is temporarily unavailable",
    };
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

/** Similar products from live Shopify data — category, vendor, tags. */
export async function getSimilarProducts(productId: string): Promise<ProductSearchResult> {
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

    if (live.length < 3 && source.productType) {
      const broader = await liveSearchProducts(`product_type:'${source.productType}'`, 25);
      live = dedupeProducts([...live, ...broader.filter((p) => p.id !== source.id)]);
    }

    let similar = live
      .map((p) => ({ p, score: scoreSimilarity(source, p) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.p);

    if (live.length < 3) {
      const { products: reranked } = await applySemanticFallbackIfNeeded(source.title, live);
      similar = dedupeProducts([...similar, ...reranked.filter((p) => p.id !== source.id)]);
    }

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

/** Category browse via live Shopify search. */
export async function searchProductByCategory(categoryQuery: string): Promise<ProductSearchResult> {
  const q = categoryQuery.trim();
  if (!q) {
    return { status: "not_found", products: [], query: q, message: STORE_NOT_FOUND_MESSAGE };
  }

  try {
    const tokens = tokenize(q);
    const queries = [
      q,
      ...tokens.map((t) => `title:*${t}*`),
      ...tokens.map((t) => `product_type:*${t}*`),
      ...tokens.map((t) => `tag:*${t}*`),
    ];

    const live = await liveSearchMulti(queries);
    const haystackQuery = normalizeSearchText(q);
    const products = live
      .map((p) => {
        const haystack = normalizeSearchText(
          `${p.title} ${p.productType} ${p.tags.join(" ")} ${p.vendor}`,
        );
        const tokenHits = tokens.filter((t) => haystack.includes(t)).length;
        const phraseHit = haystack.includes(haystackQuery) ? 2 : 0;
        return { p, score: tokenHits + phraseHit };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.p)
      .slice(0, 5);

    return {
      status: products.length ? "found" : "not_found",
      products,
      query: categoryQuery,
      message: products.length === 0 ? STORE_NOT_FOUND_MESSAGE : undefined,
    };
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
  clearSemanticIndex();
}
