import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceOrderService } from './voice-order.service';
import type { ExtendedOrderSnapshot } from './services/voice-order-lookup.service';

const bookLine = {
  title: 'The Great Gatsby',
  quantity: 1,
  sku: '9780743273565',
  variantTitle: 'Paperback',
};

const processingFeeLine = {
  title: 'Processing Fee',
  quantity: 1,
  sku: null,
  variantTitle: null,
};

function buildOrderWithFee(): ExtendedOrderSnapshot {
  return {
    id: '1',
    orderNumber: '#47569',
    createdAt: '2026-01-15T12:00:00.000Z',
    financialStatus: 'PAID',
    fulfillmentStatus: 'FULFILLED',
    cancelledAt: null,
    cancelReason: null,
    totalPrice: '52.49',
    currency: 'USD',
    customerName: 'John Smith',
    customerEmail: 'john@example.com',
    customerPhone: '+15551234567',
    shippingAddress: {
      name: 'John Smith',
      address1: '100 Main St',
      address2: null,
      city: 'Dallas',
      provinceCode: 'TX',
      zip: '75001',
      countryCode: 'US',
    },
    lineItems: [bookLine, processingFeeLine],
    fulfillments: [
      {
        status: 'SUCCESS',
        displayStatus: 'IN_TRANSIT',
        estimatedDeliveryAt: '2026-01-20T12:00:00.000Z',
        deliveredAt: null,
        inTransitAt: '2026-01-16T12:00:00.000Z',
        tracking: [{ company: 'USPS', number: '9400111111111111111111', url: null }],
      },
    ],
    refunds: [],
    paymentCardLast4: '4242',
    paymentCardBrand: 'Visa',
    subtotalWithoutShipping: '45.00',
    shippingCost: '7.49',
    shippingMethodTitle: 'Media Mail',
    shippingCarrier: 'USPS',
    orderStatus: 'shipped',
    refundStatus: null,
    extendedLineItems: [
      {
        ...bookLine,
        unfulfilledQuantity: 0,
        fulfillableQuantity: 1,
        productTags: [],
      },
      {
        ...processingFeeLine,
        unfulfilledQuantity: 0,
        fulfillableQuantity: 1,
        productTags: [],
      },
    ],
    isShipped: true,
    isCancelled: false,
    isRefunded: false,
    note: null,
  };
}

function createService(order: ExtendedOrderSnapshot | null) {
  return new VoiceOrderService(
    { lookupOrder: async () => order } as never,
    {
      checkCancellationEligibility: async () => ({
        success: true,
        cancellation_eligible: false,
        reason: 'Order has already shipped and cannot be cancelled by phone.',
        next_step: 'Escalate to customer service.',
        suggested_response: 'Order has shipped.',
      }),
    } as never,
    {
      checkOrderFacilityRestrictions: async () => ({
        success: true,
        facility_name: 'Test Facility',
        facility_approval_status: 'approved',
        items: [],
        restricted_items: [],
        suggested_response: 'All books appear acceptable.',
      }),
    } as never,
  );
}

test('get-order response never contains Processing Fee anywhere', async () => {
  const service = createService(buildOrderWithFee());
  const result = await service.getOrder({ orderNumber: '47569', callerPhone: '+19999999999' });
  const json = JSON.stringify(result);

  assert.doesNotMatch(json, /processing fee/i);
  assert.equal(result.found, true);
  assert.equal(result.order?.lineItems.length, 1);
  assert.equal(result.order?.lineItems[0]?.title, 'The Great Gatsby');
  assert.equal(result.enriched?.items.length, 1);
  assert.equal(result.enriched?.customer_facing_items.length, 1);
  assert.equal(result.hidden_internal_items_count, 1);
  assert.equal(result.subtotal_without_shipping, '45.00');
  assert.equal(result.shipping_cost, '7.49');
  assert.equal(result.subtotal_disclaimer, 'Subtotal does not include shipping.');
});

test('get-order suggested_response and voiceSummary omit Processing Fee', async () => {
  const service = createService(buildOrderWithFee());
  const result = await service.getOrder({ orderNumber: '47569' });

  assert.doesNotMatch(result.suggested_response ?? '', /processing fee/i);
  assert.doesNotMatch(result.voiceSummary ?? '', /processing fee/i);
});

test('customer_facing_items contains only real books', async () => {
  const service = createService(buildOrderWithFee());
  const result = await service.getOrder({ orderNumber: '47569' });

  assert.equal(result.customer_facing_items?.length, 1);
  assert.equal(result.customer_facing_items?.[0]?.title, 'The Great Gatsby');
  assert.ok(result.customer_facing_items?.every((item) => !/processing\s+fee/i.test(item.title)));
});
