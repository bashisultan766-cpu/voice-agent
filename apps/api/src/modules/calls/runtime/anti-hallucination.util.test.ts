import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAntiHallucinationGuard, detectHallucinatedProductClaims } from './anti-hallucination.util';

test('blocks ungrounded product claim', () => {
  const check = detectHallucinatedProductClaims('I found The Secret Moon for $12.99.', []);
  assert.equal(check.suspected, true);
});

test('allows grounded title', () => {
  const check = detectHallucinatedProductClaims('I found Dune. It is available for $14.00.', [
    { title: 'Dune', price: '$14.00' },
  ]);
  assert.equal(check.suspected, false);
});

test('applyAntiHallucinationGuard replaces unsafe reply', () => {
  const r = applyAntiHallucinationGuard('I found Unknown Book for $9.99.', undefined, []);
  assert.equal(r.hallucinationAttempt, true);
  assert.match(r.reply, /don't have verified catalog/i);
});
