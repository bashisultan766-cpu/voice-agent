/**
 * Shopify Truth Engine — single source of truth for product discovery.
 * Every query hits live Shopify GraphQL. No embeddings, cache, or AI fallback.
 */
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { isShopifyThrottleError } from "../platform/shopifyErrors.js";
import {
  isbnLookupVariants,
  isValidIsbnFormat,
  normalizeIsbn,
  normalizeSearchText,
  productMatchesIsbn,
  rankLiveProducts,
  tokenize,
} from "../utils/productSearchNormalize.js";
import type { StructuredProduct } from "../types/product.js";
import { ensureShopifyProductScopes } from "./shopifyScopeCheck.js";
import {
  liveSearchVariants,
  searchShopifyProducts,
} from "./shopifyLiveSearch.js";

export { EXACT_MATCH_NOT_FOUND_MESSAGE as STORE_NOT_FOUND_MESSAGE } from "../constants/systemMessages.js";

const MIN_RESULTS_BEFORE_EXPAND = 10;

function isSafeMode(): boolean {
  return getConfig().SAFE_MODE;
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

/** ISBN: sku OR barcode OR metafield paths — required Shopify query syntax. */
export function buildIsbnTruthQueries(isbn: string): string[] {
  const queries = new Set<string>();
  for (const variant of isbnLookupVariants(isbn)) {
    queries.add(
      `sku:*${variant}* OR barcode:*${variant}* OR metafields.custom.isbn:*${variant}* OR metafields.books.isbn:*${variant}*`,
    );
    queries.add(`sku:${variant}`);
    queries.add(`barcode:${variant}`);
    queries.add(`metafields.custom.isbn:${variant}`);
    queries.add(`metafields.books.isbn:${variant}`);
  }
  return [...queries];
}

/** Title: token OR query — required Shopify query syntax. */
export function buildTitleTruthQueries(query: string): string[] {
  const q = query.trim();
  if (!q) return [];

  const tokens = tokenize(q);
  const queries = new Set<string>();

  if (tokens.length >= 2) {
    queries.add(tokens.map((t) => `title:*${t}*`).join(" OR "));
  }
  if (tokens.length === 1) {
    queries.add(`title:*${tokens[0]}*`);
  }

  queries.add(`title:*${q}*`);
  queries.add(q);

  return [...queries];
}

/** Broader live expansion when the first pass returns too few products. */
export function buildTitleExpansionQueries(query: string): string[] {
  const tokens = tokenize(query);
  const queries = new Set<string>();

  for (const token of tokens) {
    queries.add(`title:*${token}*`);
    queries.add(`product_type:*${token}*`);
    queries.add(`tag:*${token}*`);
    queries.add(`vendor:*${token}*`);
  }

  const normalized = normalizeSearchText(query);
  if (normalized) {
    queries.add(`title:*${normalized.replace(/\s+/g, "*")}*`);
  }

  return [...queries];
}

export function buildCategoryTruthQueries(categoryQuery: string): string[] {
  const tokens = tokenize(categoryQuery);
  const queries = new Set<string>(buildTitleTruthQueries(categoryQuery));

  for (const token of tokens) {
    queries.add(`product_type:*${token}*`);
    queries.add(`tag:*${token}*`);
  }

  return [...queries];
}

async function runTruthQueries(queries: string[]): Promise<StructuredProduct[]> {
  const unique = [...new Set(queries.filter(Boolean))];
  if (unique.length === 0) return [];

  const batches = await Promise.all(
    unique.map(async (q) => {
      try {
        const [byProduct, byVariant] = await Promise.all([
          searchShopifyProducts(q),
          liveSearchVariants(q),
        ]);
        return [...byProduct, ...byVariant];
      } catch (err) {
        if (isShopifyThrottleError(err)) throw err;
        logger.warn("shopify_truth_query_failed", {
          query: q,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
    }),
  );

  return dedupeProducts(batches.flat());
}

async function expandUntilSufficient(
  products: StructuredProduct[],
  expansionQueries: string[],
): Promise<StructuredProduct[]> {
  if (products.length >= MIN_RESULTS_BEFORE_EXPAND || expansionQueries.length === 0) {
    return products;
  }

  const expanded = await runTruthQueries(expansionQueries);
  return dedupeProducts([...products, ...expanded]);
}

/**
 * Live ISBN truth search — verifies match against SKU, barcode, and metafields.
 */
export async function truthSearchByIsbn(isbn: string): Promise<StructuredProduct[]> {
  if (isSafeMode()) return [];

  const variants = isbnLookupVariants(isbn);
  const primary = variants[0] ?? normalizeIsbn(isbn);
  if (!primary || !isValidIsbnFormat(primary)) return [];

  try {
    await ensureShopifyProductScopes();
  } catch (err) {
    logger.warn("shopify_truth_scope_failed", {
      isbn: primary,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const started = Date.now();
  let live = await runTruthQueries(buildIsbnTruthQueries(primary));

  if (live.length < MIN_RESULTS_BEFORE_EXPAND) {
    live = await expandUntilSufficient(
      live,
      variants.flatMap((v) => [`sku:${v}`, `barcode:${v}`, `title:*${v}*`]),
    );
  }

  const matched = live.filter((p) => variants.some((v) => productMatchesIsbn(p, v)));
  const ranked = rankLiveProducts(matched, primary, primary);

  logger.info("shopify_truth_isbn", {
    isbn: primary,
    liveCount: live.length,
    matchCount: ranked.length,
    elapsedMs: Date.now() - started,
  });

  return ranked;
}

/**
 * Live title truth search — token OR queries with automatic expansion.
 */
export async function truthSearchByTitle(query: string): Promise<StructuredProduct[]> {
  const q = query.trim();
  if (!q || isSafeMode()) return [];

  try {
    await ensureShopifyProductScopes();
  } catch (err) {
    logger.warn("shopify_truth_scope_failed", {
      query: q,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const started = Date.now();
  let live = await runTruthQueries(buildTitleTruthQueries(q));

  if (live.length < MIN_RESULTS_BEFORE_EXPAND) {
    live = await expandUntilSufficient(live, buildTitleExpansionQueries(q));
  }

  const ranked = rankLiveProducts(live, q);

  logger.info("shopify_truth_title", {
    query: q,
    liveCount: live.length,
    resultCount: ranked.length,
    elapsedMs: Date.now() - started,
  });

  return ranked;
}

/** Category / browse — live Shopify only. */
export async function truthSearchByCategory(categoryQuery: string): Promise<StructuredProduct[]> {
  const q = categoryQuery.trim();
  if (!q || isSafeMode()) return [];

  try {
    await ensureShopifyProductScopes();
  } catch (err) {
    logger.warn("shopify_truth_scope_failed", {
      query: q,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  let live = await runTruthQueries(buildCategoryTruthQueries(q));

  if (live.length < MIN_RESULTS_BEFORE_EXPAND) {
    live = await expandUntilSufficient(live, buildTitleExpansionQueries(q));
  }

  const tokens = tokenize(q);
  const haystackQuery = normalizeSearchText(q);
  return live
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
    .map((x) => x.p);
}
