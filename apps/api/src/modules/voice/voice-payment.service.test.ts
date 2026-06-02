import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Logger } from '@nestjs/common';
import { VoicePaymentService } from './voice-payment.service';

function attachLogCapture(service: VoicePaymentService): string[] {
  const events: string[] = [];
  const logger = (service as unknown as { logger: Logger }).logger;
  const original = {
    log: logger.log.bind(logger),
    warn: logger.warn.bind(logger),
    error: logger.error.bind(logger),
  };
  logger.log = (message: unknown, ...rest: unknown[]) => {
    if (typeof message === 'string') events.push(message);
    return original.log(message, ...rest);
  };
  logger.warn = (message: unknown, ...rest: unknown[]) => {
    if (typeof message === 'string') events.push(message);
    return original.warn(message, ...rest);
  };
  logger.error = (message: unknown, ...rest: unknown[]) => {
    if (typeof message === 'string') events.push(message);
    return original.error(message, ...rest);
  };
  return events;
}

function eventNames(logLines: string[]): string[] {
  return logLines
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as { event?: string };
        return parsed.event ?? '';
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

function buildService(overrides?: {
  deliveryEmail?: 'sent' | 'skipped' | 'failed';
}) {
  const tenantId = 'tenant-test';
  const agentId = 'agent-test';

  const service = new VoicePaymentService(
    {
      sendDraftOrderPaymentLink: async () => ({
        draftOrderId: 'draft-123',
        invoiceUrl: 'https://shop.example/invoice',
        shopifyConnectionId: 'conn-1',
        shopifyInvoiceSent: false,
        shopifyInvoiceError: null,
      }),
    } as never,
    {
      deliverPaymentLink: async () => ({
        email: overrides?.deliveryEmail ?? 'sent',
        sms: 'skipped',
        whatsapp: 'skipped',
        deliveryId: 'delivery-1',
        agentMessage: 'I sent your payment link.',
        emailError: null,
        smsError: null,
        whatsappError: null,
      }),
    } as never,
    {
      resolveForPaymentLink: async () => ({
        phoneNumber: undefined,
        callSid: undefined,
        source: 'test',
        country: 'US',
      }),
    } as never,
    {
      resolveLineItem: async () => ({
        title: 'Test Book',
        quantity: 1,
        price: '9.99',
        variantId: 'gid://shopify/ProductVariant/1',
      }),
    } as never,
    {
      callSession: { findFirst: async () => null },
      agent: {
        findFirst: async () => ({
          id: agentId,
          tenantId,
          agentConfig: {
            businessName: 'Test Store',
            supportEmail: 'support@test.com',
            supportPhone: null,
          },
          client: null,
        }),
      },
      checkoutLink: {
        create: async () => ({ id: 'checkout-link-1' }),
        update: async () => ({}),
      },
    } as never,
    {
      get: (key: string) => {
        if (key === 'VOICE_DEFAULT_TENANT_ID') return tenantId;
        if (key === 'VOICE_DEFAULT_AGENT_ID') return agentId;
        return undefined;
      },
    } as never,
  );

  return { service, tenantId, agentId };
}

test('sendPaymentLink emits full success log chain for company email', async () => {
  const { service } = buildService();
  const logs = attachLogCapture(service);

  const result = await service.sendPaymentLink({
    email: 'buyer@shoreshortbooks.com',
    variantId: 'gid://shopify/ProductVariant/1',
    quantity: 1,
    emailConfirmed: true,
  });

  assert.equal(result.success, true);
  const names = eventNames(logs);
  assert.ok(names.includes('voice.payment.email_gate'), `logs: ${names.join(', ')}`);
  assert.ok(names.includes('voice.payment.started'));
  assert.ok(names.includes('voice.payment.draft_order_created'));
  assert.ok(names.includes('voice.payment.delivery_invoked'));
  assert.ok(names.includes('voice.payment.delivery_result'));
  assert.ok(names.includes('email_sent'));
  assert.ok(names.includes('voice.payment.completed'));
});

test('sendPaymentLink blocks unconfirmed Gmail at email_gate', async () => {
  const { service } = buildService();
  const logs = attachLogCapture(service);

  const result = await service.sendPaymentLink({
    email: 'buyer@gmail.com',
    variantId: 'gid://shopify/ProductVariant/1',
    quantity: 1,
    emailConfirmed: false,
  });

  assert.equal(result.success, false);
  const names = eventNames(logs);
  assert.ok(names.includes('voice.payment.email_gate'));
  assert.ok(names.includes('voice.payment.email_gate_blocked'));
  assert.equal(names.includes('voice.payment.started'), false);
});
