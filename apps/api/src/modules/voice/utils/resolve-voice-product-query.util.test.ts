import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVoiceProductQuery } from './resolve-voice-product-query.util';

test('resolveVoiceProductQuery prefers query then isbn then sku', () => {
  assert.equal(resolveVoiceProductQuery({ query: 'Atomic Habits' }), 'Atomic Habits');
  assert.equal(resolveVoiceProductQuery({ isbn: '9780143127550' }), '9780143127550');
  assert.equal(resolveVoiceProductQuery({ sku: 'SKU-1', isbn: '978' }), '978');
  assert.equal(resolveVoiceProductQuery({ search: 'fiction' }), 'fiction');
  assert.equal(resolveVoiceProductQuery({}), null);
});
