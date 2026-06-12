import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeVoiceOrderNumber,
  shopifyOrderNameSearchTokens,
} from './normalize-voice-order-number.util';

test('normalizeVoiceOrderNumber strips hash and spaces from digits', () => {
  assert.equal(normalizeVoiceOrderNumber('# 10 10'), '1010');
  assert.equal(normalizeVoiceOrderNumber('order 5544'), '5544');
});

test('shopifyOrderNameSearchTokens includes hash variant', () => {
  const tokens = shopifyOrderNameSearchTokens('1010');
  assert.ok(tokens.includes('1010'));
  assert.ok(tokens.includes('#1010'));
});
