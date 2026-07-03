/**
 * Shopify GraphQL error taxonomy — shared by live search and circuit breaker.
 */

export const SHOPIFY_THROTTLED_CODE = "THROTTLED";

export class ShopifyThrottledError extends Error {
  readonly code = SHOPIFY_THROTTLED_CODE;

  constructor(message = "Shopify GraphQL THROTTLED") {
    super(message);
    this.name = "ShopifyThrottledError";
  }
}

export class ShopifyCircuitOpenError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`Shopify circuit OPEN — retry after ${retryAfterMs}ms`);
    this.name = "ShopifyCircuitOpenError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parse Shopify Admin GraphQL error payloads for extensions.code === THROTTLED. */
export function parseShopifyGraphqlErrors(errors: unknown): ShopifyThrottledError | null {
  if (!Array.isArray(errors)) return null;

  for (const row of errors) {
    if (!row || typeof row !== "object") continue;
    const extensions = (row as { extensions?: { code?: string } }).extensions;
    const code = extensions?.code ?? (row as { code?: string }).code;
    if (code === SHOPIFY_THROTTLED_CODE) {
      const message =
        typeof (row as { message?: string }).message === "string"
          ? (row as { message: string }).message
          : "THROTTLED";
      return new ShopifyThrottledError(message);
    }
  }

  return null;
}

export function isShopifyThrottleError(err: unknown): boolean {
  if (err instanceof ShopifyThrottledError) return true;
  if (err instanceof ShopifyCircuitOpenError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /THROTTLED|throttl/i.test(message);
}
