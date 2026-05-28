export type ShopifyCheckoutCacheStrategy = 'cache_only' | 'cache_then_live' | 'live_only';

export function getShopifyCheckoutCacheStrategy(): ShopifyCheckoutCacheStrategy {
  const raw = (process.env.SHOPIFY_CHECKOUT_CACHE_STRATEGY ?? 'cache_then_live').trim().toLowerCase();
  if (raw === 'cache_only' || raw === 'live_only') return raw;
  return 'cache_then_live';
}

export function shouldReadVariantCache(strategy: ShopifyCheckoutCacheStrategy): boolean {
  return strategy !== 'live_only';
}

export function shouldFetchLiveVariantOnMiss(strategy: ShopifyCheckoutCacheStrategy): boolean {
  return strategy !== 'cache_only';
}

/** Max age of a cached variant row before checkout triggers a live refresh. */
export function getCheckoutCatalogStaleMs(): number {
  const explicit = Number(process.env.SHOPIFY_CHECKOUT_STALE_MS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const catalog = Number(process.env.CATALOG_STALE_MS);
  if (Number.isFinite(catalog) && catalog > 0) return catalog;
  return 24 * 60 * 60 * 1000;
}

export function isVariantCacheRowStale(syncedAt: Date | null | undefined, staleMs: number): boolean {
  if (!syncedAt) return true;
  return Date.now() - syncedAt.getTime() > staleMs;
}
