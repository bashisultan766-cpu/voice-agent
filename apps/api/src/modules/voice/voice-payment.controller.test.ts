import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoicePaymentController } from './voice-payment.controller';

test('send-payment-link accepts Gmail email payloads', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const controller = new VoicePaymentController({
    sendPaymentLink: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { success: true, message: 'Payment link sent successfully.' };
    },
  } as never);

  const result = await controller.sendPaymentLink({
    email: 'test@gmail.com',
    variantId: 'gid://shopify/ProductVariant/123',
    quantity: 1,
    emailConfirmed: true,
  });

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.email, 'test@gmail.com');
});

test('send-payment-link accepts company email payloads and typo confirmation key', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const controller = new VoicePaymentController({
    sendPaymentLink: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { success: true, message: 'Payment link sent successfully.' };
    },
  } as never);

  const result = await controller.sendPaymentLink({
    parameters: {
      email: 'orders@mycompany.com',
      variantId: 'gid://shopify/ProductVariant/456',
      quantity: 2,
      emailComfirmed: 'true',
    },
  } as never);

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.email, 'orders@mycompany.com');
  assert.equal(calls[0]?.emailConfirmed, true);
});

test('send-payment-link infers emailConfirmed on live call when ElevenLabs omits boolean', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const controller = new VoicePaymentController({
    sendPaymentLink: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { success: true, message: 'Payment link sent successfully.' };
    },
  } as never);

  await controller.sendPaymentLink({
    parameters: {
      email: 'jessica@sureshotbooks.com',
      variantId: 'gid://shopify/ProductVariant/123',
      quantity: 1,
      callSid: 'CA5652b993f408284b47dd9ea9c8b2128a',
    },
  } as never);

  assert.equal(calls[0]?.emailConfirmed, true);
});

test('send-payment-link accepts productName without variantId', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const controller = new VoicePaymentController({
    sendPaymentLink: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { success: true, message: 'Payment link sent successfully.' };
    },
  } as never);

  await controller.sendPaymentLink({
    parameters: {
      email: 'buyer@sureshotbooks.com',
      productName: 'A Game of Thrones',
      quantity: 1,
      callSid: 'CA5652b993f408284b47dd9ea9c8b2128a',
      emailConfirmed: true,
    },
  } as never);

  assert.equal(calls[0]?.productName, 'A Game of Thrones');
  assert.equal(calls[0]?.variantId, undefined);
  assert.equal(calls[0]?.emailConfirmed, true);
});
