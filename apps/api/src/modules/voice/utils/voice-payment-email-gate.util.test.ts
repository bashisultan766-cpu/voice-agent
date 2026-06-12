import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMAIL_POSSIBLY_INVALID_PROMPT,
  evaluatePaymentEmailGate,
  isPossiblyInvalidEmailDomain,
  PAYMENT_EMAIL_REGEX,
} from './voice-payment-email-gate.util';

test('PAYMENT_EMAIL_REGEX accepts standard addresses', () => {
  assert.match('jessica@sureshot.com', PAYMENT_EMAIL_REGEX);
  assert.match('user.name+tag@gmail.com', PAYMENT_EMAIL_REGEX);
  assert.match('jessica@shoreshortbooks.com', PAYMENT_EMAIL_REGEX);
  assert.match('orders@mycompany.co.uk', PAYMENT_EMAIL_REGEX);
  assert.match('jessica@sureshoebooks.com', PAYMENT_EMAIL_REGEX);
  assert.match('support@sureshotbooks.com', PAYMENT_EMAIL_REGEX);
  assert.match('orders@company.org', PAYMENT_EMAIL_REGEX);
  assert.match('billing@business.net', PAYMENT_EMAIL_REGEX);
  assert.match('john@gmail.com', PAYMENT_EMAIL_REGEX);
});

test('evaluatePaymentEmailGate blocks invalid format', () => {
  const result = evaluatePaymentEmailGate({ rawEmail: 'not-an-email' });
  assert.equal(result.allowed, false);
  assert.equal(result.debug.action, 'AskForEmail');
  assert.equal(result.agentMessage, EMAIL_POSSIBLY_INVALID_PROMPT);
});

test('evaluatePaymentEmailGate suggests gmail typo correction', () => {
  const result = evaluatePaymentEmailGate({
    rawEmail: 'jessica@gmil.com',
    emailConfirmed: true,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.debug.action, 'SuggestCorrection');
  assert.match(result.agentMessage, /Did you mean jessica@gmail.com/i);
  assert.equal(result.rejectionLog?.validationSource, 'internal_email_gate');
  assert.equal(result.rejectionLog?.validationResult, 'domain_typo');
});

test('evaluatePaymentEmailGate suggests SureShot store domain typo correction', () => {
  const result = evaluatePaymentEmailGate({
    rawEmail: 'jessica@sureshoebooks.com',
    emailConfirmed: true,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.debug.action, 'SuggestCorrection');
  assert.match(result.agentMessage, /sureshotbooks\.com/);
  assert.equal(result.rejectionLog?.domain, 'sureshoebooks.com');
});

test('evaluatePaymentEmailGate requires confirmation before send', () => {
  const result = evaluatePaymentEmailGate({
    rawEmail: 'buyer@gmail.com',
    emailConfirmed: false,
    sessionConfirmationState: 'pending',
  });
  assert.equal(result.allowed, false);
  assert.equal(result.debug.error, 'email_not_confirmed');
  assert.equal(result.debug.confirmationRequired, true);
});

test('evaluatePaymentEmailGate allows confirmed session email match', () => {
  const result = evaluatePaymentEmailGate({
    rawEmail: 'buyer@gmail.com',
    sessionConfirmationState: 'confirmed',
    sessionConfirmedEmail: 'buyer@gmail.com',
  });
  assert.equal(result.allowed, true);
  assert.equal(result.debug.action, 'SendPaymentLink');
});

test('evaluatePaymentEmailGate allows tool emailConfirmed flag', () => {
  const result = evaluatePaymentEmailGate({
    rawEmail: 'buyer@hotmail.com',
    emailConfirmed: true,
  });
  assert.equal(result.allowed, true);
});

test('evaluatePaymentEmailGate coerces string emailConfirmed yes/1/true', () => {
  for (const flag of ['true', 'TRUE', '1', 'yes'] as const) {
    const result = evaluatePaymentEmailGate({
      rawEmail: 'buyer@gmail.com',
      emailConfirmed: flag,
    });
    assert.equal(result.allowed, true, `expected allow for emailConfirmed=${flag}`);
    assert.equal(typeof result.possiblyInvalid, 'boolean');
  }
});

test('isPossiblyInvalidEmailDomain flags structurally invalid domains', () => {
  assert.equal(isPossiblyInvalidEmailDomain('gmail.com'), false);
  assert.equal(isPossiblyInvalidEmailDomain('shoreshortbooks.com'), false);
  assert.equal(isPossiblyInvalidEmailDomain('totallymadeup.zz'), false);
  assert.equal(isPossiblyInvalidEmailDomain('no-tld'), true);
  assert.equal(isPossiblyInvalidEmailDomain('bad..domain.com'), true);
});

test('evaluatePaymentEmailGate allows company domain with emailConfirmed', () => {
  const result = evaluatePaymentEmailGate({
    rawEmail: 'support@sureshotbooks.com',
    emailConfirmed: true,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.debug.action, 'SendPaymentLink');
  assert.equal(result.debug.customerEmail, 'support@sureshotbooks.com');
});

test('evaluatePaymentEmailGate always returns strict boolean possiblyInvalid', () => {
  const cases = [
    evaluatePaymentEmailGate({ rawEmail: 'bad' }),
    evaluatePaymentEmailGate({ rawEmail: 'jessica@gmil.com', emailConfirmed: true }),
    evaluatePaymentEmailGate({
      rawEmail: 'buyer@gmail.com',
      sessionConfirmationState: 'confirmed',
      sessionConfirmedEmail: 'other@gmail.com',
    }),
  ];
  for (const result of cases) {
    assert.equal(typeof result.possiblyInvalid, 'boolean');
  }
});

test('evaluatePaymentEmailGate uses confirmation prompt when email valid but unconfirmed', () => {
  const result = evaluatePaymentEmailGate({
    rawEmail: 'support@sureshotbooks.com',
    emailConfirmed: false,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.debug.error, 'email_not_confirmed');
  assert.match(result.agentMessage, /confirm your email/i);
});
