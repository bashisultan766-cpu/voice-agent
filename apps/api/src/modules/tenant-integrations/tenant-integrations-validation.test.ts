import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emailSaveBodySchema,
  emailTestBodySchema,
  twilioConfigureWebhookBodySchema,
  twilioSaveBodySchema,
  twilioTestBodySchema,
} from './tenant-integrations-validation';

const VALID_TWILIO_SID = `AC${'0'.repeat(32)}`;

test('emailTestBodySchema accepts payments@mailcallcommunication.com', () => {
  const parsed = emailTestBodySchema.parse({
    apiKey: 're_test_key',
    fromEmail: '  payments@mailcallcommunication.com ',
    testRecipientEmail: '  user@gmail.com ',
  });
  assert.equal(parsed.fromEmail, 'payments@mailcallcommunication.com');
  assert.equal(parsed.testRecipientEmail, 'user@gmail.com');
  assert.equal(parsed.apiKey, 're_test_key');
});

test('emailTestBodySchema allows omitted apiKey when using saved workspace key', () => {
  const parsed = emailTestBodySchema.parse({
    fromEmail: 'payments@mailcallcommunication.com',
    testRecipientEmail: 'user@gmail.com',
  });
  assert.equal(parsed.apiKey, undefined);
});

test('emailTestBodySchema rejects invalid testRecipientEmail', () => {
  const result = emailTestBodySchema.safeParse({
    apiKey: 're_test_key',
    fromEmail: 'payments@mailcallcommunication.com',
    testRecipientEmail: 'not-an-email',
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues[0]?.message, 'Test recipient email must be valid.');
  }
});

test('emailSaveBodySchema keeps apiKey optional and normalizes fromEmail', () => {
  const parsed = emailSaveBodySchema.parse({
    fromEmail: 'payments@mailcallcommunication.com',
  });
  assert.equal(parsed.fromEmail, 'payments@mailcallcommunication.com');
  assert.equal(parsed.apiKey, undefined);
});

test('emailSaveBodySchema rejects invalid fromEmail', () => {
  const result = emailSaveBodySchema.safeParse({ fromEmail: 'not-an-email' });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues[0]?.message, 'From email must be valid.');
  }
});

test('twilioSaveBodySchema accepts valid E.164 phone and AC sid', () => {
  const parsed = twilioSaveBodySchema.parse({
    accountSid: VALID_TWILIO_SID,
    authToken: ' real-token ',
    phoneNumber: ' +12512554549 ',
  });
  assert.equal(parsed.accountSid, VALID_TWILIO_SID);
  assert.equal(parsed.authToken, 'real-token');
  assert.equal(parsed.phoneNumber, '+12512554549');
});

test('twilioSaveBodySchema allows omitted auth token for saved-credential flow', () => {
  const parsed = twilioSaveBodySchema.parse({
    accountSid: VALID_TWILIO_SID,
    phoneNumber: '+12512554549',
  });
  assert.equal(parsed.authToken, undefined);
});

test('twilioSaveBodySchema rejects non-E.164 phone number', () => {
  const result = twilioSaveBodySchema.safeParse({
    accountSid: VALID_TWILIO_SID,
    authToken: 'token',
    phoneNumber: '2512554549',
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues[0]?.message, 'Phone number must be in E.164 format (e.g. +15551234567).');
  }
});

test('twilioTestBodySchema trims values and keeps authToken optional', () => {
  const parsed = twilioTestBodySchema.parse({
    accountSid: ` ${VALID_TWILIO_SID} `,
    phoneNumber: ' +12512554549 ',
  });
  assert.equal(parsed.accountSid, VALID_TWILIO_SID);
  assert.equal(parsed.phoneNumber, '+12512554549');
  assert.equal(parsed.authToken, undefined);
});

test('twilioSaveBodySchema rejects missing accountSid with clear error', () => {
  const result = twilioSaveBodySchema.safeParse({
    authToken: 'token',
    phoneNumber: '+12512554549',
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues[0]?.message, 'Account SID is required.');
  }
});

test('twilioConfigureWebhookBodySchema accepts empty body only', () => {
  const parsed = twilioConfigureWebhookBodySchema.parse({});
  assert.deepEqual(parsed, {});
});
