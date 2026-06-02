import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Logger } from '@nestjs/common';
import { VoicePaymentService } from './voice-payment.service';
import type { SearchProductResponseDto } from './dto/search-product.dto';

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

type VoiceSearchProductArgs = {
  query: string;
  tenantId?: string;
  agentId?: string;
  limit?: number;
};

function buildService(overrides?: {
  deliveryEmail?: 'sent' | 'skipped' | 'failed';
  searchProduct?: (args: VoiceSearchProductArgs) => Promise<SearchProductResponseDto>;
  callSid?: string | null;
}) {
  const tenantId = 'tenant-test';
  const agentId = 'agent-test';
  const defaultSearch: SearchProductResponseDto = {
    success: true,
    products: [
      {
        productId: 'gid://shopify/Product/1',
        variantId: 'gid://shopify/ProductVariant/48449949204717',
        title: 'A Game of Thrones',
        price: '9.99',
        inventory: 5,
        image: null,
        sku: null,
        inStock: true,
        score: 100,
      },
    ],
    cacheHit: false,
  };

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
        phoneNumber: overrides?.callSid === null ? undefined : '+12025551234',
        callSid:
          overrides?.callSid === null
            ? undefined
            : (overrides?.callSid ?? 'CA_test_call'),
        source: 'test',
        country: 'US',
      }),
    } as never,
    {
      resolveLineItem: async (
        _tenantId: string,
        _agentId: string,
        variantId: string,
        _quantity: number,
      ) => ({
        title: 'Test Book',
        quantity: 1,
        price: '9.99',
        variantId,
      }),
    } as never,
    {
      searchProduct: async (args: VoiceSearchProductArgs) =>
        overrides?.searchProduct
          ? overrides.searchProduct(args)
          : defaultSearch,
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
  const { service } = buildService({ callSid: null });
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

test('sendPaymentLink resolves variantId from productName via search-product', async () => {
  let searchQuery = '';
  const { service } = buildService({
    searchProduct: async (args) => {
      searchQuery = args.query;
      return {
        success: true,
        products: [
          {
            productId: 'gid://shopify/Product/2',
            variantId: 'gid://shopify/ProductVariant/48449949204717',
            title: 'A Game of Thrones',
            price: '12.00',
            inventory: 3,
            image: null,
            sku: 'ISBN-1',
            inStock: true,
            score: 95,
          },
        ],
      };
    },
  });
  const logs = attachLogCapture(service);

  const result = await service.sendPaymentLink({
    email: 'buyer@sureshotbooks.com',
    productName: 'A Game of Thrones',
    quantity: 1,
    callSid: 'CA_live_123',
  });

  assert.equal(searchQuery, 'A Game of Thrones');
  assert.equal(result.success, true);
  const names = eventNames(logs);
  assert.ok(names.includes('voice.payment.variant_search_started'));
  assert.ok(names.includes('voice.payment.variant_resolved_from_search'));
  assert.ok(names.includes('voice.payment.completed'));
});

test('sendPaymentLink returns gracefully when search finds no products', async () => {
  const { service } = buildService({
    searchProduct: async () => ({
      success: true,
      products: [],
    }),
  });
  const logs = attachLogCapture(service);

  const result = await service.sendPaymentLink({
    email: 'buyer@sureshotbooks.com',
    productName: 'Nonexistent Book XYZ',
    quantity: 1,
    callSid: 'CA_live_123',
  });

  assert.equal(result.success, false);
  assert.match(result.agentMessage ?? '', /couldn't find/i);
  const names = eventNames(logs);
  assert.ok(names.includes('voice.payment.variant_resolve_failed'));
  assert.equal(names.includes('voice.payment.started'), false);
});

test('sendPaymentLink prefers explicit variantId and skips search', async () => {
  let searchCalled = false;
  const { service } = buildService({
    searchProduct: async () => {
      searchCalled = true;
      return { success: true, products: [] };
    },
  });

  const result = await service.sendPaymentLink({
    email: 'buyer@sureshotbooks.com',
    variantId: 'gid://shopify/ProductVariant/999',
    productName: 'Should Not Search',
    quantity: 1,
    callSid: 'CA_live_123',
  });

  assert.equal(searchCalled, false);
  assert.equal(result.success, true);
});

test('sendPaymentLink treats placeholder variantId as missing and searches by productName', async () => {
  let searchCalled = false;
  const { service } = buildService({
    searchProduct: async () => {
      searchCalled = true;
      return {
        success: true,
        products: [
          {
            productId: 'gid://shopify/Product/3',
            variantId: 'gid://shopify/ProductVariant/111',
            title: 'Dune',
            price: '10.00',
            inventory: 1,
            image: null,
            sku: null,
            inStock: true,
            score: 90,
          },
        ],
      };
    },
  });

  const result = await service.sendPaymentLink({
    email: 'buyer@sureshotbooks.com',
    variantId: 'YOUR_VARIANT',
    productName: 'Dune',
    quantity: 1,
    callSid: 'CA_live_123',
  });

  assert.equal(searchCalled, true);
  assert.equal(result.success, true);
});

test('sendPaymentLink ignores variantId 0 and resolves via productName search', async () => {
  let searchCalled = false;
  const { service } = buildService({
    searchProduct: async () => {
      searchCalled = true;
      return {
        success: true,
        products: [
          {
            productId: 'gid://shopify/Product/4',
            variantId: 'gid://shopify/ProductVariant/48449949204717',
            title: 'A Game of Thrones',
            price: '12.00',
            inventory: 2,
            image: null,
            sku: null,
            inStock: true,
            score: 99,
          },
        ],
      };
    },
  });

  const result = await service.sendPaymentLink({
    email: 'buyer@sureshotbooks.com',
    variantId: '0',
    productName: 'A Game of Thrones',
    quantity: 1,
    callSid: 'CA_live_123',
  });

  assert.equal(searchCalled, true);
  assert.equal(result.success, true);
});
