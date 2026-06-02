import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUsableShopifyVariantId } from './resolve-payment-variant.util';

test('isUsableShopifyVariantId accepts Shopify GIDs and numeric ids', () => {
  assert.equal(
    isUsableShopifyVariantId('gid://shopify/ProductVariant/48449949204717'),
    true,
  );
  assert.equal(isUsableShopifyVariantId('48449949204717'), true);
});

test('isUsableShopifyVariantId rejects placeholders and empty values', () => {
  assert.equal(isUsableShopifyVariantId(''), false);
  assert.equal(isUsableShopifyVariantId('0'), false);
  assert.equal(isUsableShopifyVariantId('gid://shopify/ProductVariant/0'), false);
  assert.equal(isUsableShopifyVariantId('YOUR_VARIANT'), false);
  assert.equal(isUsableShopifyVariantId('PLACEHOLDER'), false);
  assert.equal(isUsableShopifyVariantId(undefined), false);
});
