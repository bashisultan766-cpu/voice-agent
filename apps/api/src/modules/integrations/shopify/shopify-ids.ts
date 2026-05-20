/**
 * Normalize Shopify Admin GIDs and legacy numeric IDs for cache lookup and storefront permalinks.
 */

export function extractTrailingNumericId(raw: string): string {
  const t = raw.trim();
  const m = t.match(/(\d+)\s*$/);
  if (m) return m[1];
  const digits = t.replace(/\D/g, '');
  return digits || '';
}

/** Admin GraphQL expects ProductVariant GIDs for draft orders. */
export function toProductVariantGid(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('gid://shopify/ProductVariant/')) return t;
  const num = extractTrailingNumericId(t);
  if (!num) return t;
  return `gid://shopify/ProductVariant/${num}`;
}

export function toProductGid(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('gid://shopify/Product/')) return t;
  const num = extractTrailingNumericId(t);
  if (!num) return t;
  return `gid://shopify/Product/${num}`;
}

/**
 * Storefront `/cart/{id}:qty` permalinks require the numeric variant id (not a GID).
 * @see https://shopify.dev/docs/api/ajax/reference/cart#generate-a-permalink-to-the-cart-page
 */
export function toStorefrontCartVariantId(raw: string): string {
  const num = extractTrailingNumericId(raw);
  if (!num) {
    throw new Error('Cannot build storefront cart id: variant id has no numeric segment.');
  }
  return num;
}

/** All plausible cache keys for a variant id the model might send. */
export function variantIdLookupKeys(raw: string): string[] {
  const t = raw.trim();
  const keys = new Set<string>();
  if (t) keys.add(t);
  const num = extractTrailingNumericId(t);
  if (num) keys.add(num).add(`gid://shopify/ProductVariant/${num}`);
  return [...keys];
}

export function productIdLookupKeys(raw: string): string[] {
  const t = raw.trim();
  const keys = new Set<string>();
  if (t) keys.add(t);
  const num = extractTrailingNumericId(t);
  if (num) keys.add(num).add(`gid://shopify/Product/${num}`);
  return [...keys];
}
