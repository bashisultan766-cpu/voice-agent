import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PAYMENT_EMAIL_SUBJECT,
  applyPaymentSubjectTemplate,
  normalizeStoreNameForSubject,
  resolvePaymentEmailSubject,
  sanitizePaymentEmailSubject,
} from './payment-email-subject.util';

test('resolvePaymentEmailSubject uses transactional default when no template or env', () => {
  const result = resolvePaymentEmailSubject({
    businessName: 'SureShot Books Publishing LLC',
  });
  assert.equal(result.subject, DEFAULT_PAYMENT_EMAIL_SUBJECT);
  assert.equal(result.source, 'default');
  assert.equal(result.overrideUsed, false);
});

test('resolvePaymentEmailSubject honors PAYMENT_EMAIL_SUBJECT env override', () => {
  const result = resolvePaymentEmailSubject({
    businessName: 'SureShot Books Publishing LLC',
    envOverride: '  Custom payment subject  ',
  });
  assert.equal(result.subject, 'Custom payment subject');
  assert.equal(result.source, 'env');
  assert.equal(result.overrideUsed, true);
});

test('resolvePaymentEmailSubject applies agent template with LLC stripped from store name', () => {
  const result = resolvePaymentEmailSubject({
    businessName: 'SureShot Books Publishing LLC',
    subjectTemplate: '{{storeName}} — Complete your secure checkout',
  });
  assert.equal(result.subject, 'SureShot Books Publishing — payment link');
  assert.equal(result.source, 'agent_template');
  assert.equal(result.overrideUsed, false);
});

test('sanitizePaymentEmailSubject removes spam triggers and caps length', () => {
  const long = `${'A'.repeat(90)} secure checkout!!!`;
  const subject = sanitizePaymentEmailSubject(long);
  assert.ok(subject.length <= 78);
  assert.ok(!/secure checkout/i.test(subject));
  assert.ok(!subject.includes('!!!'));
});

test('normalizeStoreNameForSubject strips legal suffixes', () => {
  assert.equal(normalizeStoreNameForSubject('SureShot Books Publishing LLC'), 'SureShot Books Publishing');
  assert.equal(normalizeStoreNameForSubject(''), 'SureShot Books');
});

test('applyPaymentSubjectTemplate substitutes normalized store name', () => {
  assert.equal(
    applyPaymentSubjectTemplate('Your {{storeName}} payment link', 'Acme Store LLC'),
    'Your Acme Store payment link',
  );
});
