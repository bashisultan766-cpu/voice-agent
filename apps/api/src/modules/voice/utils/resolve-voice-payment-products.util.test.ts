import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  resolveVoicePaymentProducts,
  splitMultiIsbnQuery,
} from './resolve-voice-payment-products.util';

describe('splitMultiIsbnQuery', () => {
  test('splits two ISBNs spoken in one query', () => {
    const result = splitMultiIsbnQuery('9780143127550 and 9780735211292');
    assert.deepEqual(result, ['9780143127550', '9780735211292']);
  });

  test('splits ISBNs with hyphens and commas', () => {
    const result = splitMultiIsbnQuery('978-0-14-312755-0, 978-0-7352-1129-2');
    assert.deepEqual(result, ['9780143127550', '9780735211292']);
  });

  test('does NOT split regular titles containing "and"', () => {
    const result = splitMultiIsbnQuery('1984 and Animal Farm');
    assert.deepEqual(result, ['1984 and Animal Farm']);
  });

  test('single ISBN stays intact', () => {
    assert.deepEqual(splitMultiIsbnQuery('9780143127550'), ['9780143127550']);
  });
});

describe('resolveVoicePaymentProducts', () => {
  test('products array wins over single fields', () => {
    const items = resolveVoicePaymentProducts({
      flat: {
        products: [
          { productName: 'Atomic Habits', quantity: 2 },
          { isbn: '9780735211292' },
        ],
      },
      body: {},
      singleProductName: 'ignored',
      singleQuantity: 1,
    });
    assert.equal(items.length, 2);
    assert.equal(items[0].productName, 'Atomic Habits');
    assert.equal(items[0].quantity, 2);
    assert.equal(items[1].productName, '9780735211292');
    assert.equal(items[1].quantity, 1);
  });

  test('accepts plain string entries in products array', () => {
    const items = resolveVoicePaymentProducts({
      flat: { books: ['Deep Work', 'Atomic Habits'] },
      body: {},
    });
    assert.equal(items.length, 2);
    assert.equal(items[1].productName, 'Atomic Habits');
  });

  test('accepts JSON-stringified products array', () => {
    const items = resolveVoicePaymentProducts({
      flat: { products: '[{"productName":"Deep Work"},{"productName":"Grit"}]' },
      body: {},
    });
    assert.equal(items.length, 2);
  });

  test('splits multiple ISBNs in a single productName', () => {
    const items = resolveVoicePaymentProducts({
      flat: {},
      body: {},
      singleProductName: '9780143127550 9780735211292 9781585424337',
      singleQuantity: 1,
    });
    assert.equal(items.length, 3);
    assert.equal(items[2].productName, '9781585424337');
  });

  test('single title falls through unchanged', () => {
    const items = resolveVoicePaymentProducts({
      flat: {},
      body: {},
      singleProductName: 'Atomic Habits',
      singleVariantId: 'gid://shopify/ProductVariant/123',
      singleQuantity: 3,
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].quantity, 3);
    assert.equal(items[0].variantId, 'gid://shopify/ProductVariant/123');
  });

  test('returns empty for finalize-only request', () => {
    const items = resolveVoicePaymentProducts({ flat: {}, body: {} });
    assert.equal(items.length, 0);
  });
});
