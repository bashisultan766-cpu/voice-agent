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
      sendAggregatedDraftOrderPaymentLink: async () => ({
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
      callSession: {
        findFirst: async () => null,
        create: async () => ({ id: 'sess-auto' }),
      },
      inboundCall: {
        findUnique: async () => ({
          callerPhone: '+12025551234',
          twilioNumber: '+12025555678',
        }),
      },
      checkoutLink: {
        create: async () => ({ id: 'checkout-link-1' }),
        update: async () => ({}),
        findMany: async () => [],
      },
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
    email: 'support@sureshotbooks.com',
    variantId: 'gid://shopify/ProductVariant/1',
    quantity: 1,
    emailConfirmed: true,
    finalizeCheckout: true,
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
    finalizeCheckout: true,
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
    finalizeCheckout: true,
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
    finalizeCheckout: true,
  });

  assert.equal(searchCalled, true);
  assert.equal(result.success, true);
});

test('sendPaymentLink re-sends updated invoice when a new product is added to invoiced draft', async () => {
  let aggregatedLines: Array<{ variantId: string; quantity: number }> = [];
  let sendShopifyInvoice: boolean | undefined;
  let existingDraftOrderId: string | null | undefined;
  const sessionMetadata: Record<string, unknown> = {
    paymentRecipients: [
      {
        productId: 'gid://shopify/Product/1',
        productTitle: 'Capital Seven',
        variantId: 'gid://shopify/ProductVariant/1',
        recipientEmail: 'john@gmail.com',
        paymentStatus: 'link_sent',
        draftOrderId: 'draft-existing',
        paymentLink: 'https://shop.example/invoice',
      },
    ],
    emailCheckoutBatches: {
      'john@gmail.com': {
        recipientEmail: 'john@gmail.com',
        draftOrderId: 'draft-existing',
        shopifyInvoiceSent: true,
        status: 'invoiced',
        invoicedLinesFingerprint:
          'gid://shopify/productvariant/1:1',
        lines: [
          {
            productId: 'gid://shopify/Product/1',
            variantId: 'gid://shopify/ProductVariant/1',
            productTitle: 'Capital Seven',
            quantity: 1,
          },
        ],
      },
    },
  };

  const { service } = buildService({
    callSid: 'CA_agg_test',
  });
  (service as unknown as { draftOrders: { sendAggregatedDraftOrderPaymentLink: Function } }).draftOrders =
    {
      sendAggregatedDraftOrderPaymentLink: async (_t: string, _a: string, payload: {
        lines: Array<{ variantId: string; quantity: number }>;
        existingDraftOrderId?: string | null;
        sendShopifyInvoice?: boolean;
      }) => {
        aggregatedLines = payload.lines;
        existingDraftOrderId = payload.existingDraftOrderId;
        sendShopifyInvoice = payload.sendShopifyInvoice;
        return {
          draftOrderId: 'draft-existing',
          invoiceUrl: 'https://shop.example/invoice',
          shopifyConnectionId: 'conn-1',
          shopifyInvoiceSent: true,
          shopifyInvoiceError: null,
        };
      },
    } as never;

  const prisma = (service as unknown as { prisma: { callSession: { findFirst: Function; update: Function } } })
    .prisma;
  prisma.callSession.findFirst = async () => ({ id: 'sess-1', metadata: sessionMetadata });
  prisma.callSession.update = async (args: { data: { metadata: Record<string, unknown> } }) => {
    Object.assign(sessionMetadata, args.data.metadata);
    return {};
  };

  const result = await service.sendPaymentLink({
    email: 'john@gmail.com',
    variantId: 'gid://shopify/ProductVariant/2',
    productName: 'Illuminati',
    quantity: 1,
    callSid: 'CA_agg_test',
    emailConfirmed: true,
    finalizeCheckout: true,
  });

  assert.equal(result.success, true);
  assert.equal(aggregatedLines.length, 2);
  assert.equal(existingDraftOrderId, 'draft-existing');
  assert.equal(sendShopifyInvoice, true);
  assert.equal(result.delivery?.email, 'skipped');
});

test('sendPaymentLink hydrates checkout state from prior checkout links when call session is empty', async () => {
  let existingDraftOrderId: string | null | undefined;
  let sendShopifyInvoice: boolean | undefined;
  const { service } = buildService({ callSid: 'CA_hydrate_test', deliveryEmail: 'skipped' });
  (service as unknown as { draftOrders: { sendAggregatedDraftOrderPaymentLink: Function } }).draftOrders =
    {
      sendAggregatedDraftOrderPaymentLink: async (_t: string, _a: string, payload: {
        existingDraftOrderId?: string | null;
        sendShopifyInvoice?: boolean;
      }) => {
        existingDraftOrderId = payload.existingDraftOrderId;
        sendShopifyInvoice = payload.sendShopifyInvoice;
        return {
          draftOrderId: 'gid://shopify/DraftOrder/1',
          invoiceUrl: 'https://shop.example/invoice-1',
          shopifyConnectionId: 'conn-1',
          shopifyInvoiceSent: true,
          shopifyInvoiceError: null,
        };
      },
    } as never;

  const prisma = (service as unknown as {
    prisma: {
      callSession: { findFirst: Function; update: Function; create: Function };
      checkoutLink: { findMany: Function; create: Function; update: Function };
    };
  }).prisma;
  prisma.callSession.findFirst = async () => ({ id: 'sess-1', metadata: {} });
  prisma.callSession.create = async () => ({ id: 'sess-1' });
  prisma.callSession.update = async () => ({});
  prisma.checkoutLink.findMany = async () => [
    {
      id: 'cl-1',
      providerRef: 'gid://shopify/DraftOrder/1',
      checkoutUrl: 'https://shop.example/invoice-1',
      customerEmail: 'john@gmail.com',
      itemsJson: [
        {
          title: 'Capital Seven',
          quantity: 1,
          price: '9.99',
          variantId: 'gid://shopify/ProductVariant/1',
        },
      ],
      metadata: { callSid: 'CA_hydrate_test', shopifyInvoiceSent: true },
      status: 'SENT',
      sentAt: new Date(),
      createdAt: new Date(),
    },
  ];

  const result = await service.sendPaymentLink({
    email: 'john@gmail.com',
    variantId: 'gid://shopify/ProductVariant/2',
    productName: 'Illuminati',
    quantity: 1,
    callSid: 'CA_hydrate_test',
    emailConfirmed: true,
    finalizeCheckout: true,
  });

  assert.equal(result.success, true);
  assert.equal(existingDraftOrderId, 'gid://shopify/DraftOrder/1');
  assert.equal(sendShopifyInvoice, true);
  assert.equal(result.delivery?.email, 'skipped');
});

test('sendPaymentLink queues product when finalizeCheckout is false', async () => {
  let shopifyCalled = false;
  const sessionMetadata: Record<string, unknown> = {};
  const { service } = buildService({ callSid: 'CA_queue_test' });
  (service as unknown as { draftOrders: { sendAggregatedDraftOrderPaymentLink: Function } }).draftOrders =
    {
      sendAggregatedDraftOrderPaymentLink: async () => {
        shopifyCalled = true;
        return {
          draftOrderId: 'draft-1',
          invoiceUrl: 'https://shop.example/invoice',
          shopifyConnectionId: 'conn-1',
          shopifyInvoiceSent: false,
          shopifyInvoiceError: null,
        };
      },
    } as never;

  const prisma = (service as unknown as { prisma: { callSession: { findFirst: Function; update: Function } } })
    .prisma;
  prisma.callSession.findFirst = async () => ({ id: 'sess-1', metadata: sessionMetadata });
  prisma.callSession.update = async (args: { data: { metadata: Record<string, unknown> } }) => {
    Object.assign(sessionMetadata, args.data.metadata);
    return {};
  };

  const result = await service.sendPaymentLink({
    email: 'john@gmail.com',
    variantId: 'gid://shopify/ProductVariant/1',
    quantity: 1,
    callSid: 'CA_queue_test',
    emailConfirmed: true,
    finalizeCheckout: false,
  });

  assert.equal(result.success, true);
  assert.equal(shopifyCalled, false);
  assert.match(result.agentMessage ?? '', /added that book/i);
  const batches = sessionMetadata.emailCheckoutBatches as Record<string, { lines: unknown[] }>;
  assert.equal(batches['john@gmail.com']?.lines?.length, 1);
});

test('sendPaymentLink accumulates queued lines across multiple finalizeCheckout false calls', async () => {
  const sessionMetadata: Record<string, unknown> = {};
  const { service } = buildService({ callSid: 'CA_queue_multi' });
  (service as unknown as { draftOrders: { sendAggregatedDraftOrderPaymentLink: Function } }).draftOrders =
    {
      sendAggregatedDraftOrderPaymentLink: async () => ({
        draftOrderId: 'draft-1',
        invoiceUrl: 'https://shop.example/invoice',
        shopifyConnectionId: 'conn-1',
        shopifyInvoiceSent: false,
        shopifyInvoiceError: null,
      }),
    } as never;

  const prisma = (service as unknown as {
    prisma: {
      callSession: { findFirst: Function; update: Function; create: Function };
      checkoutLink: { findMany: Function };
    };
  }).prisma;
  prisma.callSession.findFirst = async () => ({ id: 'sess-1', metadata: sessionMetadata });
  prisma.callSession.create = async () => ({ id: 'sess-1' });
  prisma.callSession.update = async (args: { data: { metadata: Record<string, unknown> } }) => {
    Object.assign(sessionMetadata, args.data.metadata);
    return {};
  };
  prisma.checkoutLink.findMany = async () => [];

  await service.sendPaymentLink({
    email: 'john@gmail.com',
    variantId: 'gid://shopify/ProductVariant/1',
    quantity: 1,
    callSid: 'CA_queue_multi',
    emailConfirmed: true,
    finalizeCheckout: false,
  });
  await service.sendPaymentLink({
    email: 'john@gmail.com',
    variantId: 'gid://shopify/ProductVariant/2',
    quantity: 1,
    callSid: 'CA_queue_multi',
    emailConfirmed: true,
    finalizeCheckout: false,
  });

  const batches = sessionMetadata.emailCheckoutBatches as Record<string, { lines: unknown[] }>;
  assert.equal(batches['john@gmail.com']?.lines?.length, 2);
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
    finalizeCheckout: true,
  });

  assert.equal(searchCalled, true);
  assert.equal(result.success, true);
});

test('sendPaymentLink auto-queues second book when finalizeCheckout is omitted', async () => {
  let shopifyCalls = 0;
  const sessionMetadata: Record<string, unknown> = {};
  const { service } = buildService({ callSid: 'CA_auto_queue' });
  (service as unknown as { draftOrders: { sendAggregatedDraftOrderPaymentLink: Function } }).draftOrders =
    {
      sendAggregatedDraftOrderPaymentLink: async () => {
        shopifyCalls += 1;
        return {
          draftOrderId: 'draft-1',
          invoiceUrl: 'https://shop.example/invoice',
          shopifyConnectionId: 'conn-1',
          shopifyInvoiceSent: true,
          shopifyInvoiceError: null,
        };
      },
    } as never;

  const prisma = (service as unknown as {
    prisma: {
      callSession: { findFirst: Function; update: Function; create: Function };
      checkoutLink: { findMany: Function; create: Function; update: Function };
    };
  }).prisma;
  prisma.callSession.findFirst = async () => ({ id: 'sess-1', metadata: sessionMetadata });
  prisma.callSession.create = async () => ({ id: 'sess-1' });
  prisma.callSession.update = async (args: { data: { metadata: Record<string, unknown> } }) => {
    Object.assign(sessionMetadata, args.data.metadata);
    return {};
  };
  prisma.checkoutLink.findMany = async () => [];
  prisma.checkoutLink.create = async () => ({ id: 'link-1' });
  prisma.checkoutLink.update = async () => ({});

  await service.sendPaymentLink({
    email: 'john@gmail.com',
    variantId: 'gid://shopify/ProductVariant/1',
    quantity: 1,
    callSid: 'CA_auto_queue',
    emailConfirmed: true,
  });

  const second = await service.sendPaymentLink({
    email: 'john@gmail.com',
    variantId: 'gid://shopify/ProductVariant/2',
    quantity: 1,
    callSid: 'CA_auto_queue',
    emailConfirmed: true,
  });

  assert.equal(shopifyCalls, 1);
  assert.equal(second.success, true);
  assert.match(second.agentMessage ?? '', /added that book/i);
  const batches = sessionMetadata.emailCheckoutBatches as Record<string, { lines: unknown[] }>;
  assert.equal(batches['john@gmail.com']?.lines?.length, 2);
});

test('sendPaymentLinkForProducts sends ONE invoice with ALL books even without callSid', async () => {
  let aggregatedLines: Array<{ variantId: string; quantity: number }> = [];
  let shopifyCalls = 0;
  const searchResults: Record<string, string> = {
    'Book One': 'gid://shopify/ProductVariant/101',
    'Book Two': 'gid://shopify/ProductVariant/102',
    'Book Three': 'gid://shopify/ProductVariant/103',
  };
  const { service } = buildService({
    // No callSid — reproduces ElevenLabs tool calls without system__call_sid.
    callSid: null,
    searchProduct: async (args) => ({
      success: true,
      products: [
        {
          productId: `gid://shopify/Product/${args.query}`,
          variantId: searchResults[args.query] ?? 'gid://shopify/ProductVariant/999',
          title: args.query,
          price: '9.99',
          inventory: 5,
          image: null,
          sku: null,
          inStock: true,
          score: 100,
        },
      ],
    }),
  });
  (service as unknown as { draftOrders: { sendAggregatedDraftOrderPaymentLink: Function } }).draftOrders =
    {
      sendAggregatedDraftOrderPaymentLink: async (
        _tenantId: string,
        _agentId: string,
        payload: { lines: Array<{ variantId: string; quantity: number }> },
      ) => {
        shopifyCalls += 1;
        aggregatedLines = payload.lines;
        return {
          draftOrderId: 'draft-multi',
          invoiceUrl: 'https://shop.example/invoice',
          shopifyConnectionId: 'conn-1',
          shopifyInvoiceSent: true,
          shopifyInvoiceError: null,
        };
      },
    } as never;

  const result = await service.sendPaymentLinkForProducts({
    items: [
      { productName: 'Book One', quantity: 1 },
      { productName: 'Book Two', quantity: 1 },
      { productName: 'Book Three', quantity: 1 },
    ],
    email: 'buyer@sureshotbooks.com',
    emailConfirmed: true,
    finalizeCheckout: true,
  });

  assert.equal(result.success, true);
  assert.equal(shopifyCalls, 1, 'exactly one Shopify invoice');
  assert.equal(aggregatedLines.length, 3, 'all 3 books on the invoice');
  const variantIds = aggregatedLines.map((l) => l.variantId).sort();
  assert.deepEqual(variantIds, [
    'gid://shopify/ProductVariant/101',
    'gid://shopify/ProductVariant/102',
    'gid://shopify/ProductVariant/103',
  ]);
});

test('sendPaymentLinkForProducts keeps remaining books when one ISBN is not found', async () => {
  let aggregatedLines: Array<{ variantId: string; quantity: number }> = [];
  const { service } = buildService({
    callSid: null,
    searchProduct: async (args) =>
      args.query === 'Missing Book'
        ? { success: true, products: [] }
        : {
            success: true,
            products: [
              {
                productId: `gid://shopify/Product/${args.query}`,
                variantId: `gid://shopify/ProductVariant/${args.query.length}`,
                title: args.query,
                price: '9.99',
                inventory: 5,
                image: null,
                sku: null,
                inStock: true,
                score: 100,
              },
            ],
          },
  });
  (service as unknown as { draftOrders: { sendAggregatedDraftOrderPaymentLink: Function } }).draftOrders =
    {
      sendAggregatedDraftOrderPaymentLink: async (
        _tenantId: string,
        _agentId: string,
        payload: { lines: Array<{ variantId: string; quantity: number }> },
      ) => {
        aggregatedLines = payload.lines;
        return {
          draftOrderId: 'draft-partial',
          invoiceUrl: 'https://shop.example/invoice',
          shopifyConnectionId: 'conn-1',
          shopifyInvoiceSent: true,
          shopifyInvoiceError: null,
        };
      },
    } as never;

  const result = await service.sendPaymentLinkForProducts({
    items: [
      { productName: 'Book One', quantity: 1 },
      { productName: 'Missing Book', quantity: 1 },
      { productName: 'Book Three', quantity: 1 },
    ],
    email: 'buyer@sureshotbooks.com',
    emailConfirmed: true,
    finalizeCheckout: true,
  });

  assert.equal(result.success, true);
  assert.equal(aggregatedLines.length, 2, 'two found books still invoiced');
  assert.match(result.agentMessage ?? '', /could not find Missing Book/i);
});

test('sendPaymentLink finalize-only sends one aggregated invoice for queued books', async () => {
  let aggregatedLineCount = 0;
  const sessionMetadata: Record<string, unknown> = {
    emailCheckoutBatches: {
      'john@gmail.com': {
        recipientEmail: 'john@gmail.com',
        draftOrderId: null,
        shopifyInvoiceSent: false,
        status: 'accumulating',
        lines: [
          {
            productId: 'gid://shopify/ProductVariant/1',
            variantId: 'gid://shopify/ProductVariant/1',
            productTitle: 'Book A',
            quantity: 1,
          },
          {
            productId: 'gid://shopify/ProductVariant/2',
            variantId: 'gid://shopify/ProductVariant/2',
            productTitle: 'Book B',
            quantity: 1,
          },
        ],
      },
    },
  };
  const { service } = buildService({ callSid: 'CA_finalize_only' });
  (service as unknown as { draftOrders: { sendAggregatedDraftOrderPaymentLink: Function } }).draftOrders =
    {
      sendAggregatedDraftOrderPaymentLink: async (
        _tenantId: string,
        _agentId: string,
        payload: { lines: unknown[] },
      ) => {
        aggregatedLineCount = payload.lines.length;
        return {
          draftOrderId: 'draft-agg',
          invoiceUrl: 'https://shop.example/invoice',
          shopifyConnectionId: 'conn-1',
          shopifyInvoiceSent: true,
          shopifyInvoiceError: null,
        };
      },
    } as never;

  const prisma = (service as unknown as {
    prisma: {
      callSession: { findFirst: Function; update: Function; create: Function };
      checkoutLink: { findMany: Function; create: Function; update: Function };
    };
  }).prisma;
  prisma.callSession.findFirst = async () => ({ id: 'sess-1', metadata: sessionMetadata });
  prisma.callSession.create = async () => ({ id: 'sess-1' });
  prisma.callSession.update = async (args: { data: { metadata: Record<string, unknown> } }) => {
    Object.assign(sessionMetadata, args.data.metadata);
    return {};
  };
  prisma.checkoutLink.findMany = async () => [];
  prisma.checkoutLink.create = async () => ({ id: 'link-agg' });
  prisma.checkoutLink.update = async () => ({});

  const result = await service.sendPaymentLink({
    email: 'john@gmail.com',
    callSid: 'CA_finalize_only',
    emailConfirmed: true,
    finalizeCheckout: true,
  });

  assert.equal(result.success, true);
  assert.equal(aggregatedLineCount, 2);
  assert.match(result.agentMessage ?? '', /all 2 books/i);
});
