/**
 * Deterministic product retrieval policy — SessionProductMemory is authoritative.
 */
import type { SessionProductMemory } from "../memory/callMemoryStore.js";
import {
  isCompleteIsbnValue,
  normalizeIsbn,
  scoreTitleMatch,
} from "../utils/productSearchNormalize.js";
import type { StructuredProduct } from "../types/product.js";

export const STRONG_TITLE_MATCH_SCORE = 2;

export interface ProductSearchContext {
  memory: SessionProductMemory;
  explicitRepeat: boolean;
  forceFreshTitleQuery: boolean;
  wantsRecommendations?: boolean;
}

export interface ProductIdentityValidation {
  valid: boolean;
  reason: string;
}

export interface SlotMemorySyncLog {
  slotIsbn?: string;
  slotTitle?: string;
  memoryIsbn?: string;
  memoryTitle?: string;
  memoryWins: boolean;
  searchKey?: string;
}

export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ");
}

export function isExplicitRepeatRequest(message: string): boolean {
  return /\b(again|same book|that (one|book)|repeat|look (it|that) up again|one more time)\b/i.test(
    message,
  );
}

export function buildProductSearchKey(memory: Pick<SessionProductMemory, "isbn" | "title">): string | undefined {
  if (memory.isbn && isCompleteIsbnValue(memory.isbn)) {
    return `isbn:${normalizeIsbn(memory.isbn)}`;
  }
  if (memory.title?.trim()) {
    return `title:${normalizeTitle(memory.title).toLowerCase()}`;
  }
  return undefined;
}

export function parseTitleFromSearchKey(searchKey?: string): string | undefined {
  if (!searchKey?.startsWith("title:")) return undefined;
  return searchKey.slice("title:".length);
}

export function hasValidIsbn(memory: SessionProductMemory): boolean {
  return Boolean(memory.isbn && isCompleteIsbnValue(memory.isbn));
}

export function isNewTitleSearch(memory: SessionProductMemory, currentSearchKey: string): boolean {
  if (!memory.lastSearchKey?.startsWith("title:")) return Boolean(memory.title);
  return memory.lastSearchKey !== currentSearchKey;
}

export function isMemorySearchReady(memory: SessionProductMemory): boolean {
  if (hasValidIsbn(memory) && memory.isbnCollected) return true;
  if (memory.title?.trim() && memory.titleCollected) return true;
  return false;
}

export function isStrongTitleMatch(product: StructuredProduct, queryTitle: string): boolean {
  return scoreTitleMatch(product.title, queryTitle) >= STRONG_TITLE_MATCH_SCORE;
}

export type TitleSearchMode = "exact" | "ambiguous" | "alternatives" | "none";

export function selectTitleSearchResults(
  products: StructuredProduct[],
  queryTitle: string,
): { products: StructuredProduct[]; mode: TitleSearchMode } {
  const scored = products
    .map((p) => ({ product: p, score: scoreTitleMatch(p.title, queryTitle) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  const strong = scored
    .filter((row) => row.score >= STRONG_TITLE_MATCH_SCORE)
    .map((row) => row.product);

  if (strong.length > 1) {
    return { products: strong.slice(0, 3), mode: "ambiguous" };
  }
  if (strong.length === 1) {
    return { products: [strong[0]], mode: "exact" };
  }

  const alternatives = scored.slice(0, 3).map((row) => row.product);
  if (alternatives.length > 0) {
    return { products: alternatives, mode: "alternatives" };
  }

  return { products: [], mode: "none" };
}

export function validateProductIdentity(
  product: StructuredProduct,
  ctx: ProductSearchContext,
  searchKind: "isbn" | "title",
): ProductIdentityValidation {
  const { memory, explicitRepeat } = ctx;

  if (
    !explicitRepeat &&
    memory.lastResultProductId &&
    product.id === memory.lastResultProductId
  ) {
    const searchKey = buildProductSearchKey(memory);
    if (searchKind === "title" && searchKey && isNewTitleSearch(memory, searchKey)) {
      return { valid: false, reason: "stale_product_id_for_new_title" };
    }
    if (searchKind === "title" && !explicitRepeat) {
      return { valid: false, reason: "repeated_product_without_explicit_request" };
    }
  }

  if (searchKind === "isbn" && memory.isbn) {
    const target = normalizeIsbn(memory.isbn);
    const productIsbns = product.isbns ?? [];
    const variantIds = product.variants.map((v) => v.sku ?? v.barcode ?? "").filter(Boolean);
    const matches = [...productIsbns, ...variantIds].some((raw) => normalizeIsbn(raw) === target);
    return matches
      ? { valid: true, reason: "isbn_match" }
      : { valid: false, reason: "isbn_mismatch" };
  }

  if (searchKind === "title" && memory.title) {
    const matches = isStrongTitleMatch(product, memory.title);
    return matches
      ? { valid: true, reason: "title_match" }
      : { valid: false, reason: "title_mismatch" };
  }

  return { valid: true, reason: "no_constraint" };
}

export function filterValidatedProducts(
  products: StructuredProduct[],
  ctx: ProductSearchContext,
  searchKind: "isbn" | "title",
): { accepted: StructuredProduct[]; rejections: ProductIdentityValidation[] } {
  const accepted: StructuredProduct[] = [];
  const rejections: ProductIdentityValidation[] = [];

  for (const product of products) {
    const result = validateProductIdentity(product, ctx, searchKind);
    if (result.valid) {
      accepted.push(product);
    } else {
      rejections.push(result);
    }
  }

  return { accepted, rejections };
}

export type ToolExecutionReason =
  | "isbn_in_memory"
  | "title_in_memory_new_search_key"
  | "title_in_memory_explicit_repeat"
  | "recommendations_in_memory"
  | "missing_memory"
  | "validation_not_ready"
  | "order_number_present"
  | "non_product_intent";

export function resolveProductToolAction(
  memory: SessionProductMemory,
  validationReady: boolean,
  explicitRepeat: boolean,
  wantsRecommendations = false,
): { action: "searchProductByISBN" | "searchProductByTitle" | "getSimilarProducts" | "ASK_QUESTION"; reason: ToolExecutionReason } {
  if (!validationReady) {
    return { action: "ASK_QUESTION", reason: "validation_not_ready" };
  }

  if (hasValidIsbn(memory) && memory.isbnCollected) {
    return { action: "searchProductByISBN", reason: "isbn_in_memory" };
  }

  if (memory.title?.trim() && memory.titleCollected) {
    const searchKey = buildProductSearchKey(memory);
    if (searchKey && (isNewTitleSearch(memory, searchKey) || explicitRepeat)) {
      return {
        action: "searchProductByTitle",
        reason: explicitRepeat ? "title_in_memory_explicit_repeat" : "title_in_memory_new_search_key",
      };
    }
  }

  if (wantsRecommendations) {
    return { action: "getSimilarProducts", reason: "recommendations_in_memory" };
  }

  return { action: "ASK_QUESTION", reason: "missing_memory" };
}

export interface CanonicalProduct {
  id: string;
  normalizedTitle: string;
  isbn?: string;
  sourceFingerprint: string;
  shopifyRawId: string;
  confidenceScore: number;
  raw: StructuredProduct;
}

export interface CanonicalValidation {
  valid: boolean;
  reason: string;
  shouldRetry: boolean;
}

export interface CanonicalResolution {
  accepted: CanonicalProduct[];
  rejected: CanonicalValidation[];
  shouldRetry: boolean;
  validationFailed: boolean;
  candidates: CanonicalProduct[];
}

function extractProductIsbn(product: StructuredProduct): string | undefined {
  const fromList = product.isbns?.find((raw) => normalizeIsbn(raw).length >= 10);
  if (fromList) return normalizeIsbn(fromList);
  for (const variant of product.variants) {
    const sku = variant.sku ?? variant.barcode ?? "";
    const normalized = normalizeIsbn(sku);
    if (normalized.length >= 10) return normalized;
  }
  return undefined;
}

function exactNormalizedTitle(title: string): string {
  return normalizeTitle(title).toLowerCase();
}

function computeConfidenceScore(
  product: StructuredProduct,
  queryTitle?: string,
  queryIsbn?: string,
): number {
  const productIsbn = extractProductIsbn(product);
  if (queryIsbn && productIsbn && normalizeIsbn(queryIsbn) === productIsbn) {
    return 1;
  }
  if (queryTitle) {
    const query = exactNormalizedTitle(queryTitle);
    const candidate = exactNormalizedTitle(product.title);
    if (candidate === query) return 1;
    if (candidate.includes(query) || query.includes(candidate)) return 0.5;
  }
  return 0;
}

/** Convert raw Shopify product → canonical identity (never validate raw directly). */
export function normalizeProduct(
  product: StructuredProduct,
  sourceFingerprint: string,
  query?: { title?: string; isbn?: string },
): CanonicalProduct {
  const isbn = extractProductIsbn(product);
  const normalizedTitle = exactNormalizedTitle(product.title);
  const confidenceScore = computeConfidenceScore(product, query?.title, query?.isbn);

  return {
    id: product.id,
    normalizedTitle,
    isbn,
    sourceFingerprint,
    shopifyRawId: product.id,
    confidenceScore,
    raw: product,
  };
}

function exactMatchScore(canonical: CanonicalProduct, queryTitle?: string): number {
  if (!queryTitle) return canonical.confidenceScore;
  return canonical.normalizedTitle === exactNormalizedTitle(queryTitle) ? 1 : 0;
}

/** Sanitize Shopify results — dedupe, resolve ISBN conflicts, deterministic sort. */
export function sanitizeShopifyResponse(
  products: CanonicalProduct[],
  queryTitle?: string,
): CanonicalProduct[] {
  const byTitle = new Map<string, CanonicalProduct>();
  for (const product of products) {
    const existing = byTitle.get(product.normalizedTitle);
    if (!existing || product.confidenceScore > existing.confidenceScore) {
      byTitle.set(product.normalizedTitle, product);
    }
  }

  const titleDeduped = [...byTitle.values()];

  const byIsbn = new Map<string, CanonicalProduct[]>();
  for (const product of titleDeduped) {
    if (!product.isbn) continue;
    const group = byIsbn.get(product.isbn) ?? [];
    group.push(product);
    byIsbn.set(product.isbn, group);
  }

  const isbnConflictIds = new Set<string>();
  for (const group of byIsbn.values()) {
    if (group.length <= 1) continue;
    const titles = new Set(group.map((p) => p.normalizedTitle));
    if (titles.size > 1) {
      for (const p of group) isbnConflictIds.add(p.id);
    }
  }

  const sanitized = titleDeduped
    .filter((p) => !isbnConflictIds.has(p.id))
    .sort((a, b) => {
      const scoreDiff = exactMatchScore(b, queryTitle) - exactMatchScore(a, queryTitle);
      if (scoreDiff !== 0) return scoreDiff;
      return b.confidenceScore - a.confidenceScore;
    });

  return sanitized;
}

/** Strict canonical identity validation — no fuzzy title acceptance. */
export function validateCanonicalProduct(
  product: CanonicalProduct,
  memory: SessionProductMemory,
  explicitRepeat: boolean,
  searchKey: string,
): CanonicalValidation {
  if (product.sourceFingerprint !== searchKey) {
    return { valid: false, reason: "source_fingerprint_mismatch", shouldRetry: true };
  }

  if (
    !explicitRepeat &&
    memory.lastResultProductId &&
    product.id === memory.lastResultProductId
  ) {
    return { valid: false, reason: "stale_product_id", shouldRetry: true };
  }

  const memoryIsbn = memory.isbn ? normalizeIsbn(memory.isbn) : undefined;
  const memoryTitle = memory.title ? exactNormalizedTitle(memory.title) : undefined;

  const isbnMatch = Boolean(memoryIsbn && product.isbn && product.isbn === memoryIsbn);
  const titleExactMatch = Boolean(
    memoryTitle && product.normalizedTitle === memoryTitle,
  );

  if (!isbnMatch && !titleExactMatch) {
    return { valid: false, reason: "identity_mismatch", shouldRetry: true };
  }

  return { valid: true, reason: isbnMatch ? "isbn_match" : "title_exact_match", shouldRetry: false };
}

export function resolveCanonicalProducts(
  products: CanonicalProduct[],
  memory: SessionProductMemory,
  explicitRepeat: boolean,
  searchKey: string,
): CanonicalResolution {
  const validations = products.map((product) => ({
    product,
    result: validateCanonicalProduct(product, memory, explicitRepeat, searchKey),
  }));

  const accepted = validations.filter((row) => row.result.valid).map((row) => row.product);
  const rejected = validations.filter((row) => !row.result.valid).map((row) => row.result);
  const shouldRetry = rejected.some((row) => row.shouldRetry);

  const resolution: CanonicalResolution = {
    accepted,
    rejected,
    shouldRetry,
    validationFailed: accepted.length === 0 && products.length > 0,
    candidates: products,
  };

  return resolution;
}

export function shouldDisableTitleFallback(ctx: ProductSearchContext): boolean {
  const searchKey = buildProductSearchKey(ctx.memory);
  return ctx.forceFreshTitleQuery || Boolean(searchKey && isNewTitleSearch(ctx.memory, searchKey));
}

/** @deprecated Use resolveCanonicalProducts — wraps canonical validation for orchestrator response gate. */
export interface FinalResponseValidation {
  ok: boolean;
  reason?: string;
  shouldRetry: boolean;
}

export function validateFinalResponse(
  memory: SessionProductMemory,
  explicitRepeat: boolean,
  expectedSearchKey: string | undefined,
  executedSearchKey: string,
  products: StructuredProduct[],
  searchKind: "isbn" | "title" | "recommendations",
): FinalResponseValidation {
  if (searchKind === "recommendations" || products.length === 0) {
    return { ok: true, shouldRetry: false };
  }

  const searchKey = expectedSearchKey ?? executedSearchKey;
  const query =
    searchKind === "isbn"
      ? { isbn: memory.isbn }
      : { title: memory.title };

  const canonical = sanitizeShopifyResponse(
    products.map((p) => normalizeProduct(p, searchKey, query)),
    memory.title,
  );

  const resolution = resolveCanonicalProducts(canonical, memory, explicitRepeat, searchKey);
  if (resolution.accepted.length === 1) {
    return { ok: true, shouldRetry: false };
  }
  if (resolution.accepted.length > 1) {
    return { ok: false, reason: "multiple_canonical_matches", shouldRetry: false };
  }
  return {
    ok: false,
    reason: resolution.rejected[0]?.reason ?? "canonical_validation_failed",
    shouldRetry: resolution.shouldRetry,
  };
}
