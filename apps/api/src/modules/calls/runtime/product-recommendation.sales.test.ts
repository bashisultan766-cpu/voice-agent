import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractInterestSignalsFromText,
  rankProductRecommendations,
} from './product-recommendation.util';

test('extractInterestSignalsFromText finds motivational and religious', () => {
  const s = extractInterestSignalsFromText('Any motivational self-help or bible study books?');
  assert.ok(s.includes('motivational') || s.includes('self-help'));
  assert.ok(s.includes('religious'));
});

test('rankProductRecommendations boosts budget-friendly when price sensitive', () => {
  const ranked = rankProductRecommendations(
    [
      {
        productId: 'a',
        title: 'Premium Hardcover',
        tags: 'fiction',
        variants: [{ variantId: 'v1', price: '89.00', inventoryQuantity: 5, availableForSale: true }],
      },
      {
        productId: 'b',
        title: 'Budget Paperback',
        tags: 'fiction',
        variants: [{ variantId: 'v2', price: '9.99', inventoryQuantity: 5, availableForSale: true }],
      },
    ],
    { priceSensitivity: 'high' },
    2,
  );
  assert.equal(ranked[0]?.productId, 'b');
});
