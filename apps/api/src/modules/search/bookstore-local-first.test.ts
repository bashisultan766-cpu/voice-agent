import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_SEARCH_SKIP_SHOPIFY_MIN_NORMALIZED,
  LOCAL_SEARCH_SKIP_SHOPIFY_MIN_SCORE,
} from './bookstore-local-first.util';

test('local search skip threshold is 0.75 normalized', () => {
  assert.equal(LOCAL_SEARCH_SKIP_SHOPIFY_MIN_NORMALIZED, 0.75);
  assert.equal(LOCAL_SEARCH_SKIP_SHOPIFY_MIN_SCORE, 750);
});
