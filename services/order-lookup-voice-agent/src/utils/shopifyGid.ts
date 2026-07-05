import { isValidIsbnFormat, normalizeIsbn } from "./productSearchNormalize.js";

export const PRODUCT_VARIANT_GID_PREFIX = "gid://shopify/ProductVariant/";

/** True when a numeric token is an ISBN — must never be sent as a Shopify variant id. */
export function isIsbnLikeId(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (!digits) return false;
  if (digits.length === 10 || digits.length === 13) {
    return isValidIsbnFormat(normalizeIsbn(digits));
  }
  return false;
}

/**
 * Normalize to a valid ProductVariant GID, or null when the value is an ISBN / product id / invalid.
 */
export function parseVariantGid(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("custom:") || trimmed.startsWith("title:")) {
    return null;
  }

  if (trimmed.startsWith("gid://shopify/Product/")) {
    return null;
  }

  if (trimmed.startsWith(PRODUCT_VARIANT_GID_PREFIX)) {
    const suffix = trimmed.slice(PRODUCT_VARIANT_GID_PREFIX.length);
    if (!suffix || isIsbnLikeId(suffix)) return null;
    return `${PRODUCT_VARIANT_GID_PREFIX}${suffix.replace(/\D/g, "")}`;
  }

  const digits = trimmed.replace(/\D/g, "");
  if (!digits || isIsbnLikeId(digits)) return null;

  return `${PRODUCT_VARIANT_GID_PREFIX}${digits}`;
}

export function toProductGid(productId: string): string {
  const trimmed = productId.trim();
  if (trimmed.startsWith("gid://shopify/Product/")) return trimmed;
  if (isIsbnLikeId(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  return digits ? `gid://shopify/Product/${digits}` : trimmed;
}
