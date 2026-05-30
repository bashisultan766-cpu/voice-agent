import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateTypoQueryVariants,
  normalizeVoiceText,
  splitMultilingualTitleFragments,
} from './voice-text-normalize.util';
import { rankVoiceProducts } from './voice-product-ranking.util';

test('normalizeVoiceText strips accents and punctuation', () => {
  assert.equal(normalizeVoiceText('  Hábitos Atómicos! '), 'habitos atomicos');
});

test('splitMultilingualTitleFragments splits on slash', () => {
  const parts = splitMultilingualTitleFragments('Hábitos Atómicos / Atomic Habits');
  assert.equal(parts.length, 2);
  assert.equal(parts[1], 'Atomic Habits');
});

test('generateTypoQueryVariants includes singular and typo forms', () => {
  const v = generateTypoQueryVariants('Atomic Habits', 2);
  assert.ok(v.includes('Atomic Habits'));
  assert.ok(v.some((x) => x === 'Atomic Habit'));
});

test('rankVoiceProducts prefers English fragment for Atomic Habits query', () => {
  const { products } = rankVoiceProducts(
    'Atomic Habits',
    [
      {
        productId: 'gid://shopify/Product/1',
        variantId: 'gid://shopify/ProductVariant/1',
        title: 'Hábitos Atómicos / Atomic Habits',
        price: '$18.00',
        inventory: 5,
        image: null,
        sku: 'BK-1',
        inStock: true,
        skus: ['BK-1'],
        barcodes: [],
      },
      {
        productId: 'gid://shopify/Product/2',
        variantId: 'gid://shopify/ProductVariant/2',
        title: 'Some Other Book',
        price: '$10.00',
        inventory: 1,
        image: null,
        sku: 'BK-2',
        inStock: true,
        skus: ['BK-2'],
        barcodes: [],
      },
    ],
    null,
    5,
  );
  assert.ok(products.length >= 1);
  assert.equal(products[0].title.includes('Atomic Habits'), true);
  assert.ok(products[0].score >= 82);
  assert.ok(products[0].matchedTokens.includes('atomic'));
  assert.ok(products[0].matchedTokens.includes('habits'));
});

test('typo query Atomc Habits still ranks Atomic Habits title highly', () => {
  const { products } = rankVoiceProducts(
    'Atomc Habits',
    [
      {
        productId: 'gid://shopify/Product/1',
        variantId: 'gid://shopify/ProductVariant/1',
        title: 'Hábitos Atómicos / Atomic Habits',
        price: '$18.00',
        inventory: 8,
        image: null,
        sku: 'BK-1',
        inStock: true,
        skus: ['BK-1'],
        barcodes: [],
      },
    ],
    null,
    5,
  );
  assert.ok(products[0].score >= 70);
});
