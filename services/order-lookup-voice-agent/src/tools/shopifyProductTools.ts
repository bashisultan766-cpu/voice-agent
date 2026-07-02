import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  extractIsbnFromSpeech,
  isbnLookupVariants,
  isValidIsbnFormat,
  normalizeIsbn,
  normalizeSearchText,
  rankBySearchScore,
  scoreTitleMatch,
  tagOverlapScore,
  tokenize,
} from "../utils/productSearchNormalize.js";
import {
  getProductById,
  getProductCatalog,
  lookupProductIdsByIsbn,
  clearCatalogCache,
} from "./productCatalog.js";
import { semanticProductSearch, clearSemanticIndex, tokenFallbackSearch } from "./productSemanticSearch.js";
import type {
  InventoryStatus,
  ProductSearchResult,
  StructuredProduct,
} from "../types/product.js";

const resultCache = new Map<string, { expiresAt: number; value: ProductSearchResult }>();

function cacheGet(key: string): ProductSearchResult | null {
  const entry = resultCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    resultCache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key: string, value: ProductSearchResult): void {
  const ttl = getConfig().SHOPIFY_CACHE_TTL_SECS * 1000;
  resultCache.set(key, { value, expiresAt: Date.now() + ttl });
}

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

/** Layer 1 + Layer 3 — robust title search with token scoring and semantic fallback. */
export async function searchProductByTitle(query: string): Promise<ProductSearchResult> {
  const q = query.trim();
  if (!q) return { status: "not_found", products: [], query: q };

  const cacheKey = `title:${q.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const { products: catalog } = await getProductCatalog();

    const ranked = rankBySearchScore(catalog, q, 1).slice(0, 5);
    let products = ranked.map(({ searchScore: _s, ...p }) => p);

    const topScore = ranked[0]?.searchScore ?? 0;
    if (products.length === 0 || topScore < 3) {
      const semantic = await semanticProductSearch(q, catalog, 3);
      products = dedupeProducts([...products, ...semantic]).slice(0, 5);
    }

    if (products.length === 0) {
      products = tokenFallbackSearch(q, catalog, 5);
    }

    const result: ProductSearchResult = {
      status: products.length ? "found" : "not_found",
      products,
      query: q,
    };
    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    logger.error("title_search_failed", {
      query: q,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "api_error", products: [], query: q, message: "Product catalog unavailable" };
  }
}

async function searchIsbnViaGraphql(isbn: string): Promise<StructuredProduct[]> {
  const { products: catalog } = await getProductCatalog();
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const hits: StructuredProduct[] = [];

  for (const variant of isbnLookupVariants(isbn)) {
    try {
      const gql = await shopifyGraphql<{
        products: {
          edges: Array<{
            node: {
              id: string;
              title: string;
              handle: string;
              productType: string;
              vendor: string;
              tags: string[];
              description: string;
              variants: {
                edges: Array<{
                  node: {
                    id: string;
                    sku: string;
                    barcode: string;
                    price: string;
                    inventoryQuantity: number;
                  };
                }>;
              };
            };
          }>;
        };
      }>(
        `query ($q: String!) {
          products(first: 5, query: $q) {
            edges {
              node {
                id title handle productType vendor tags description
                variants(first: 5) {
                  edges { node { id sku barcode price inventoryQuantity } }
                }
              }
            }
          }
        }`,
        { q: `barcode:${variant} OR sku:${variant}` },
      );

      for (const { node } of gql.products?.edges ?? []) {
        const id = node.id.replace("gid://shopify/Product/", "");
        const existing = byId.get(id);
        if (existing) {
          hits.push(existing);
          continue;
        }
        hits.push({
          id,
          title: node.title,
          handle: node.handle,
          productType: node.productType ?? "",
          vendor: node.vendor ?? "",
          author: node.vendor ?? undefined,
          tags: node.tags ?? [],
          isbns: [variant],
          descriptionSnippet: node.description?.slice(0, 160),
          variants: (node.variants?.edges ?? []).map(({ node: v }) => ({
            id: v.id.replace("gid://shopify/ProductVariant/", ""),
            sku: v.sku,
            barcode: v.barcode,
            price: v.price,
            inStock: v.inventoryQuantity > 0,
            inventoryQuantity: v.inventoryQuantity,
          })),
        });
      }
    } catch {
      // continue with next variant
    }
  }

  return dedupeProducts(hits);
}

async function shopifyGraphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const cfg = getConfig();
  const domain = cfg.SHOPIFY_SHOP_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.SHOPIFY_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://${domain}/admin/api/${cfg.SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": cfg.SHOPIFY_ADMIN_ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      },
    );
    if (!res.ok) throw new Error(`graphql_http_${res.status}`);
    const body = (await res.json()) as { data?: T; errors?: unknown[] };
    if (body.errors?.length) throw new Error("graphql_error");
    return body.data as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Layer 2 — ISBN search via SKU, barcode, metafields, partial SKU (never title search). */
export async function searchProductByISBN(isbn: string): Promise<ProductSearchResult> {
  const variants = isbnLookupVariants(isbn);
  const primary = variants[0] ?? normalizeIsbn(isbn);
  if (!primary || !isValidIsbnFormat(primary)) {
    return { status: "not_found", products: [], query: isbn };
  }

  const cacheKey = `isbn:${primary}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    await getProductCatalog();
    const hits: StructuredProduct[] = [];

    for (const lookup of variants) {
      const ids = lookupProductIdsByIsbn(lookup);
      for (const id of ids) {
        const product = getProductById(id);
        if (product) hits.push(product);
      }
    }

    if (hits.length === 0) {
      hits.push(...(await searchIsbnViaGraphql(primary)));
    }

    const products = dedupeProducts(hits).slice(0, 5);
    const result: ProductSearchResult = {
      status: products.length ? "found" : "not_found",
      products,
      query: primary,
    };
    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    logger.error("isbn_search_failed", {
      isbn: primary,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "api_error", products: [], query: primary, message: "ISBN lookup unavailable" };
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

/** Similar products — category, author/vendor, tags, semantic fallback. Never empty if catalog has items. */
export async function getSimilarProducts(productId: string): Promise<ProductSearchResult> {
  const cacheKey = `similar:${productId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const { products: catalog } = await getProductCatalog();
    const source = getProductById(productId) ?? catalog.find((p) => p.id === productId);
    if (!source) {
      return { status: "not_found", products: [], query: `similar:${productId}` };
    }

    let similar = catalog
      .map((p) => ({ p, score: scoreSimilarity(source, p) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.p);

    if (similar.length < 3) {
      const semantic = await semanticProductSearch(source.title, catalog, 5);
      similar = dedupeProducts([...similar, ...semantic.filter((p) => p.id !== source.id)]);
    }

    if (similar.length < 3) {
      const categoryPeers = catalog.filter(
        (p) => p.id !== source.id && p.productType === source.productType,
      );
      similar = dedupeProducts([...similar, ...categoryPeers]);
    }

    if (similar.length < 3) {
      similar = dedupeProducts([
        ...similar,
        ...catalog.filter((p) => p.id !== source.id),
      ]);
    }

    const outOfStock = !productInStock(source);
    const products = (outOfStock ? similar.filter(productInStock) : similar).slice(0, 5);
    const finalProducts = products.length >= 3 ? products : similar.slice(0, 3);

    const result: ProductSearchResult = {
      status: finalProducts.length ? "found" : "not_found",
      products: finalProducts,
      query: `similar:${productId}`,
    };
    cacheSet(cacheKey, result);
    return result;
  } catch {
    return { status: "api_error", products: [], query: productId };
  }
}

/** Category browse — magazines, newspapers, books for inmates. */
export async function searchProductByCategory(categoryQuery: string): Promise<ProductSearchResult> {
  const q = categoryQuery.trim().toLowerCase();
  const cacheKey = `category:${q}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const { products: catalog } = await getProductCatalog();
    const tokens = tokenize(q);

    const products = catalog
      .map((p) => {
        const haystack = normalizeSearchText(
          `${p.title} ${p.productType} ${p.tags.join(" ")} ${p.vendor}`,
        );
        const hits = tokens.filter((t) => haystack.includes(t)).length;
        return { p, hits };
      })
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .map((x) => x.p)
      .slice(0, 5);

    const result: ProductSearchResult = {
      status: products.length ? "found" : "not_found",
      products,
      query: categoryQuery,
    };
    cacheSet(cacheKey, result);
    return result;
  } catch {
    return { status: "api_error", products: [], query: categoryQuery };
  }
}

export async function checkInventory(productId: string): Promise<InventoryStatus | null> {
  const product = getProductById(productId) ?? (await getProductCatalog()).products.find((p) => p.id === productId);
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
  resultCache.clear();
  clearCatalogCache();
  clearSemanticIndex();
}
