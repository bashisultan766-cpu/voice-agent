import test from 'node:test';
import assert from 'node:assert/strict';
import { emailSaveBodySchema, emailTestBodySchema } from './tenant-integrations-validation';

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
