import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAgentDeliveryMessage } from './agent-delivery-message.util';

test('email only success message', () => {
  const msg = buildAgentDeliveryMessage({
    email: 'sent',
    sms: 'skipped',
    whatsapp: 'skipped',
  });
  assert.equal(msg, 'Perfect, I sent the payment link to your email.');
});

test('email and SMS success message', () => {
  const msg = buildAgentDeliveryMessage({
    email: 'sent',
    sms: 'sent',
    whatsapp: 'skipped',
  });
  assert.equal(msg, 'Perfect, I sent the payment link to your email and by text message.');
});

test('email and WhatsApp success message', () => {
  const msg = buildAgentDeliveryMessage({
    email: 'sent',
    sms: 'skipped',
    whatsapp: 'sent',
  });
  assert.equal(msg, 'Perfect, I sent the payment link to your email and WhatsApp.');
});

test('email failure message', () => {
  const msg = buildAgentDeliveryMessage({
    email: 'failed',
    sms: 'skipped',
    whatsapp: 'skipped',
  });
  assert.match(msg, /having trouble sending the email/i);
});
