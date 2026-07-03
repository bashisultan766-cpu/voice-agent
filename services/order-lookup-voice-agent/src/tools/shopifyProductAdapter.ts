/**
 * Shopify search isolation — fingerprinted queries, no cross-title cache reuse.
 */
import { createHash } from "node:crypto";
import { logger } from "../utils/logger.js";
import {
  normalizeProduct,
  normalizeTitle as policyNormalizeTitle,
  sanitizeShopifyResponse,
  type CanonicalProduct,
} from "../agents/productRetrievalPolicy.js";
import { assertToolAccessAuthorized } from "../guards/toolAccessGuard.js";
import { assertToolExecutionAllowed } from "../guards/toolExecutionGuard.js";
import { truthSearchByIsbn, truthSearchByTitle } from "./shopifyTruthSearch.js";
import type { ProductSearchResult, StructuredProduct } from "../types/product.js";
import { STORE_NOT_FOUND_MESSAGE } from "./shopifyProductTools.js";

const EXACT_MATCH_THRESHOLD = 0.98;

const lastTitleFingerprintByCall = new Map<string, string>();
const fingerprintResultCache = new Map<string, StructuredProduct[]>();

export function computeTitleSearchFingerprint(callSid: string, title: string): string {
  const normalized = policyNormalizeTitle(title).toLowerCase();
  return createHash("sha256").update(`${normalized}:${callSid}`).digest("hex").slice(0, 16);
}

export function computeIsbnSearchFingerprint(callSid: string, isbn: string): string {
  const normalized = isbn.replace(/\D/g, "");
  return createHash("sha256").update(`isbn:${normalized}:${callSid}`).digest("hex").slice(0, 16);
}

function localNormalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

function titleMatchScore(product: StructuredProduct, queryTitle: string): number {
  const a = localNormalizeTitle(product.title);
  const b = localNormalizeTitle(queryTitle);
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  return 0;
}

function dedupeById(products: StructuredProduct[]): StructuredProduct[] {
  const seen = new Set<string>();
  const out: StructuredProduct[] = [];
  for (const p of products) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

function toResult(products: StructuredProduct[], query: string): ProductSearchResult {
  const ranked = products.slice(0, 5);
  return {
    status: ranked.length ? "found" : "not_found",
    products: ranked,
    query,
    message: ranked.length === 0 ? STORE_NOT_FOUND_MESSAGE : undefined,
  };
}

async function withShopifyApiRetryOnce<T>(
  callSid: string,
  operation: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (firstErr) {
    logger.warn("shopify_api_retry", {
      callSid: callSid.slice(0, 8),
      operation,
      error: firstErr instanceof Error ? firstErr.message : String(firstErr),
    });
    return work();
  }
}

export interface IsolatedTitleSearchOptions {
  excludeProductId?: string;
  strictExactOnly?: boolean;
}

/** Title search with per-call fingerprint — never reuses cache across different titles. */
export async function searchProductByTitleIsolated(
  callSid: string,
  title: string,
  options: IsolatedTitleSearchOptions = {},
): Promise<ProductSearchResult> {
  assertToolAccessAuthorized("searchProductByTitle", "shopifyProductAdapter.ts");
  assertToolExecutionAllowed("searchProductByTitle", "shopifyProductAdapter.ts");

  const q = title.trim();
  if (!q) {
    return { status: "not_found", products: [], query: q, message: STORE_NOT_FOUND_MESSAGE };
  }

  const fingerprint = computeTitleSearchFingerprint(callSid, q);
  const previousFingerprint = lastTitleFingerprintByCall.get(callSid);
  const fingerprintChanged = Boolean(previousFingerprint && previousFingerprint !== fingerprint);

  logger.info("shopify_query_fingerprint", {
    callSid: callSid.slice(0, 8),
    fingerprint,
    fingerprintChanged,
    strictExactOnly: options.strictExactOnly ?? false,
    excludeProductId: options.excludeProductId,
    title: q,
  });

  if (fingerprintChanged) {
    for (const key of fingerprintResultCache.keys()) {
      if (key.startsWith(`${callSid}:`)) fingerprintResultCache.delete(key);
    }
  }
  lastTitleFingerprintByCall.set(callSid, fingerprint);

  const cacheKey = `${callSid}:${fingerprint}:${options.strictExactOnly ? "strict" : "normal"}`;
  if (!fingerprintChanged && fingerprintResultCache.has(cacheKey)) {
    let cached = fingerprintResultCache.get(cacheKey) ?? [];
    if (options.excludeProductId) {
      cached = cached.filter((p) => p.id !== options.excludeProductId);
    }
    return toResult(cached, q);
  }

  let products = await withShopifyApiRetryOnce(callSid, "title_search", () => truthSearchByTitle(q));
  products = dedupeById(products);

  if (options.excludeProductId) {
    products = products.filter((p) => p.id !== options.excludeProductId);
  }

  if (options.strictExactOnly) {
    products = products.filter((p) => titleMatchScore(p, q) >= EXACT_MATCH_THRESHOLD);
  }

  const hasStaleRepeat =
    options.excludeProductId &&
    products.some((p) => p.id === options.excludeProductId);

  if (hasStaleRepeat || (products.length > 0 && !options.strictExactOnly)) {
    const ambiguous = products.filter((p) => titleMatchScore(p, q) < EXACT_MATCH_THRESHOLD);
    if (ambiguous.length > 0 && !options.strictExactOnly) {
      const strict = await searchProductByTitleIsolated(callSid, q, {
        ...options,
        strictExactOnly: true,
      });
      if (strict.products.length > 0) {
        products = strict.products;
      }
    }
  }

  fingerprintResultCache.set(cacheKey, products);
  return toResult(products, q);
}

/** ISBN search with fingerprint (no cross-session bleed). */
export async function searchProductByISBNIsolated(
  callSid: string,
  isbn: string,
  options: { excludeProductId?: string } = {},
): Promise<ProductSearchResult> {
  assertToolAccessAuthorized("searchProductByISBN", "shopifyProductAdapter.ts");
  assertToolExecutionAllowed("searchProductByISBN", "shopifyProductAdapter.ts");

  const fingerprint = computeIsbnSearchFingerprint(callSid, isbn);
  logger.info("shopify_query_fingerprint", {
    callSid: callSid.slice(0, 8),
    fingerprint,
    kind: "isbn",
    isbn,
  });

  let products = await withShopifyApiRetryOnce(callSid, "isbn_search", () => truthSearchByIsbn(isbn));
  if (options.excludeProductId) {
    products = products.filter((p) => p.id !== options.excludeProductId);
  }
  return toResult(dedupeById(products), isbn);
}

export function clearShopifyAdapterState(callSid: string): void {
  lastTitleFingerprintByCall.delete(callSid);
  for (const key of fingerprintResultCache.keys()) {
    if (key.startsWith(`${callSid}:`)) fingerprintResultCache.delete(key);
  }
}

/** Shopify → normalizeProduct → sanitizeShopifyResponse (validation happens downstream). */
export function processShopifySearchResults(
  rawProducts: StructuredProduct[],
  searchKey: string,
  query: { title?: string; isbn?: string },
  callSid?: string,
): CanonicalProduct[] {
  const normalized = rawProducts.map((product) => {
    const canonical = normalizeProduct(product, searchKey, query);
    if (callSid) {
      logger.info("canonical_product_created", {
        callSid: callSid.slice(0, 8),
        productId: canonical.id,
        normalizedTitle: canonical.normalizedTitle,
        isbn: canonical.isbn,
        sourceFingerprint: canonical.sourceFingerprint,
        confidenceScore: canonical.confidenceScore,
      });
    }
    return canonical;
  });

  const sanitized = sanitizeShopifyResponse(normalized, query.title);
  if (callSid) {
    logger.info("shopify_sanitized_results", {
      callSid: callSid.slice(0, 8),
      rawCount: rawProducts.length,
      normalizedCount: normalized.length,
      sanitizedCount: sanitized.length,
      searchKey,
    });
  }
  return sanitized;
}
