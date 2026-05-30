import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildShopifyProductSearchQueries,
  extractIsbnDigits,
  looksLikeSku,
} from './shopify-query-builder.util';

test('extractIsbnDigits finds ISBN-13', () => {
  assert.equal(extractIsbnDigits('ISBN 9780735211292 please'), '9780735211292');
});

test('looksLikeSku accepts compact codes', () => {
  assert.equal(looksLikeSku('BK-ATOMIC-01'), true);
  assert.equal(looksLikeSku('Atomic Habits'), false);
});

test('buildShopifyProductSearchQueries includes title and token AND', () => {
  const q = buildShopifyProductSearchQueries('Atomic Habits');
  assert.ok(q.some((x) => x.includes('title:"Atomic Habits"')));
  assert.ok(q.some((x) => x.includes('atomic AND habits')));
});

test('buildShopifyProductSearchQueries adds barcode for ISBN utterance', () => {
  const q = buildShopifyProductSearchQueries('9780735211292');
  assert.ok(q.some((x) => x.startsWith('barcode:')));
});
