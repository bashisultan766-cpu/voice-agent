import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectDomainTypo,
  isDisposableEmailDomain,
  suggestEmailTypo,
  validateEnterpriseEmail,
  validateEnterpriseEmailSync,
} from './voice-email-enterprise-validation.util';

test('detectDomainTypo corrects common gmail misspellings', () => {
  assert.equal(detectDomainTypo('gmial.com'), 'gmail.com');
  assert.equal(detectDomainTypo('gmal.com'), 'gmail.com');
  assert.equal(detectDomainTypo('gmail.com'), null);
});

test('suggestEmailTypo returns corrected address for gmial.com', () => {
  const suggestion = suggestEmailTypo('buyer@gmial.com');
  assert.ok(suggestion);
  assert.equal(suggestion.correctedEmail, 'buyer@gmail.com');
  assert.equal(suggestion.fromDomain, 'gmial.com');
  assert.equal(suggestion.toDomain, 'gmail.com');
});

test('validateEnterpriseEmailSync flags disposable domains', () => {
  const result = validateEnterpriseEmailSync('shopper@mailinator.com');
  assert.equal(result.disposable, true);
  assert.equal(result.valid, false);
  assert.equal(result.blockedReason, 'disposable');
});

test('validateEnterpriseEmailSync flags typo domains as typo_pending', () => {
  const result = validateEnterpriseEmailSync('reader@gmial.com');
  assert.equal(result.regexValid, true);
  assert.equal(result.valid, false);
  assert.equal(result.blockedReason, 'typo_pending');
  assert.ok(result.typoSuggestion);
});

test('validateEnterpriseEmail uses injected MX resolver', async () => {
  const valid = await validateEnterpriseEmail('reader@example.com', {
    mxResolver: async () => true,
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.mxValid, true);
  assert.equal(valid.mxChecked, true);

  const invalid = await validateEnterpriseEmail('reader@example.com', {
    mxResolver: async () => false,
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.blockedReason, 'mx_missing');
});

test('isDisposableEmailDomain detects known throwaway hosts', () => {
  assert.equal(isDisposableEmailDomain('yopmail.com'), true);
  assert.equal(isDisposableEmailDomain('gmail.com'), false);
});
