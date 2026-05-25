import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankProductRecommendations, extractGenrePreferencesFromText } from './product-recommendation.util';

test('extractGenrePreferencesFromText finds mystery', () => {
  assert.deepEqual(extractGenrePreferencesFromText('I want a mystery novel'), ['mystery']);
});

test('rankProductRecommendations prefers in-stock bestseller tag', () => {
  const ranked = rankProductRecommendations(
    [
      {
        productId: '1',
        title: 'Obscure Title',
        tags: 'niche',
        variants: [{ variantId: 'a', price: '10', inventoryQuantity: 0, availableForSale: false }],
      },
      {
        productId: '2',
        title: 'Bestseller Mystery',
        tags: 'bestseller, mystery',
        variants: [{ variantId: 'b', price: '12', inventoryQuantity: 5, availableForSale: true }],
      },
    ],
    { preferredGenres: ['mystery'], queryTokens: ['mystery'] },
    2,
  );
  assert.equal(ranked[0]?.productId, '2');
  assert.ok(ranked[0]?.matchReasons.includes('in_stock'));
});
