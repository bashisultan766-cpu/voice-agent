import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeCallerPhone, phonesLikelyMatch } from './caller-phone.util';

describe('caller-phone.util', () => {
  test('normalizes NANP numbers consistently', () => {
    assert.equal(normalizeCallerPhone('(251) 555-1234').normalized, '+12515551234');
    assert.equal(normalizeCallerPhone('(251) 555-1234').digits, '2515551234');
  });

  test('matches +1 and 10-digit variants', () => {
    assert.equal(phonesLikelyMatch('+12515551234', '2515551234'), true);
    assert.equal(phonesLikelyMatch('+12515551234', '+19875551234'), false);
  });
});
