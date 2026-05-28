import test from 'node:test';
import assert from 'node:assert/strict';
import { formatShopifyErrorForCaller, ShopifyCheckoutValidationError } from './shopify-errors';

test('VARIANT_NOT_IN_CACHE never exposes synced catalog internals', () => {
  const err = new ShopifyCheckoutValidationError(
    'VARIANT_NOT_IN_CACHE',
    'No matching variant found in the synced catalog for this store. Ref: gid://shopify/ProductVariant/1',
  );
  const msg = formatShopifyErrorForCaller(err);
  assert.doesNotMatch(msg, /synced catalog/i);
  assert.doesNotMatch(msg, /catalog sync/i);
  assert.match(msg, /checkout link/i);
});

test('VARIANT_UNAVAILABLE is customer-safe', () => {
  const err = new ShopifyCheckoutValidationError('VARIANT_UNAVAILABLE', 'internal unavailable');
  const msg = formatShopifyErrorForCaller(err);
  assert.doesNotMatch(msg, /internal/i);
  assert.match(msg, /not available/i);
});
