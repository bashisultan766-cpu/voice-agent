import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCheckoutCatalogStaleMs,
  getShopifyCheckoutCacheStrategy,
  isVariantCacheRowStale,
  shouldFetchLiveVariantOnMiss,
  shouldReadVariantCache,
} from './shopify-checkout-cache-strategy.util';

test('default checkout cache strategy is cache_then_live', () => {
  const prev = process.env.SHOPIFY_CHECKOUT_CACHE_STRATEGY;
  delete process.env.SHOPIFY_CHECKOUT_CACHE_STRATEGY;
  try {
    const strategy = getShopifyCheckoutCacheStrategy();
    assert.equal(strategy, 'cache_then_live');
    assert.equal(shouldReadVariantCache(strategy), true);
    assert.equal(shouldFetchLiveVariantOnMiss(strategy), true);
  } finally {
    if (prev !== undefined) process.env.SHOPIFY_CHECKOUT_CACHE_STRATEGY = prev;
  }
});

test('cache_only disables live fallback', () => {
  const prev = process.env.SHOPIFY_CHECKOUT_CACHE_STRATEGY;
  process.env.SHOPIFY_CHECKOUT_CACHE_STRATEGY = 'cache_only';
  try {
    const strategy = getShopifyCheckoutCacheStrategy();
    assert.equal(strategy, 'cache_only');
    assert.equal(shouldFetchLiveVariantOnMiss(strategy), false);
  } finally {
    if (prev !== undefined) process.env.SHOPIFY_CHECKOUT_CACHE_STRATEGY = prev;
    else delete process.env.SHOPIFY_CHECKOUT_CACHE_STRATEGY;
  }
});

test('isVariantCacheRowStale treats missing syncedAt as stale', () => {
  assert.equal(isVariantCacheRowStale(undefined, 60_000), true);
  assert.equal(isVariantCacheRowStale(new Date(Date.now() - 120_000), 60_000), true);
  assert.equal(isVariantCacheRowStale(new Date(), 60_000), false);
});

test('getCheckoutCatalogStaleMs prefers SHOPIFY_CHECKOUT_STALE_MS', () => {
  const prevCheckout = process.env.SHOPIFY_CHECKOUT_STALE_MS;
  const prevCatalog = process.env.CATALOG_STALE_MS;
  process.env.SHOPIFY_CHECKOUT_STALE_MS = '900000';
  delete process.env.CATALOG_STALE_MS;
  try {
    assert.equal(getCheckoutCatalogStaleMs(), 900_000);
  } finally {
    if (prevCheckout !== undefined) process.env.SHOPIFY_CHECKOUT_STALE_MS = prevCheckout;
    else delete process.env.SHOPIFY_CHECKOUT_STALE_MS;
    if (prevCatalog !== undefined) process.env.CATALOG_STALE_MS = prevCatalog;
  }
});
