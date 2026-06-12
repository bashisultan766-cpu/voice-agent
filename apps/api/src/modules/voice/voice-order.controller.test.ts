import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { VoiceOrderController } from './voice-order.controller';

test('get-order requires order number query param', () => {
  const controller = new VoiceOrderController({ getOrder: async () => ({ success: true, found: false }) } as never);
  assert.throws(() => controller.getOrder({}), BadRequestException);
});

test('get-order resolves order_number and forwards to service', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const controller = new VoiceOrderController({
    getOrder: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { success: true, found: true, voiceSummary: 'ok' };
    },
  } as never);

  await controller.getOrder({ order_number: '#1010' });
  assert.equal(calls[0]?.orderNumber, '1010');
});

test('post get-order accepts ElevenLabs parameters wrapper', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const controller = new VoiceOrderController({
    getOrder: async (args: Record<string, unknown>) => {
      calls.push(args);
      return { success: true, found: true };
    },
  } as never);

  await controller.postGetOrder({
    parameters: { orderNumber: '5544' },
  });
  assert.equal(calls[0]?.orderNumber, '5544');
});
