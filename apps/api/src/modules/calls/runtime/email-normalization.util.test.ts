import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpokenEmail } from './email-normalization.util';

test('normalizes spoken email with at/dot and digits', () => {
  const normalized = normalizeSpokenEmail('bashi sultan seven six six at gmail dot com');
  assert.equal(normalized, 'bashisultan766@gmail.com');
});

