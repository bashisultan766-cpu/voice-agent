import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVoiceOrderSummary } from './build-voice-order-summary.util';
import type { VoiceOrderDetailDto } from '../dto/get-order.dto';

const baseOrder: VoiceOrderDetailDto = {
  id: '1',
  orderNumber: '#1010',
  createdAt: '2026-03-01T12:00:00.000Z',
  financialStatus: 'PAID',
  fulfillmentStatus: 'FULFILLED',
  cancelledAt: null,
  cancelReason: null,
  totalPrice: '49.99',
  currency: 'USD',
  customerName: 'Jane Doe',
  customerEmail: 'jane@example.com',
  customerPhone: null,
  shippingAddress: {
    name: 'Jane Doe',
    address1: '123 Main St',
    address2: null,
    city: 'Dallas',
    provinceCode: 'TX',
    zip: '75001',
    countryCode: 'US',
  },
  lineItems: [
    { title: 'Algebra 1', quantity: 2, sku: '9781', variantTitle: 'Paperback' },
  ],
  fulfillments: [
    {
      status: 'SUCCESS',
      displayStatus: 'IN_TRANSIT',
      estimatedDeliveryAt: '2026-03-10T12:00:00.000Z',
      deliveredAt: null,
      inTransitAt: '2026-03-05T12:00:00.000Z',
      tracking: [{ company: 'USPS', number: '9400111899223344556677', url: null }],
    },
  ],
  refunds: [],
  paymentCardLast4: null,
  paymentCardBrand: null,
};

test('buildVoiceOrderSummary includes status tracking and items', () => {
  const summary = buildVoiceOrderSummary(baseOrder);
  assert.match(summary, /Order #1010/);
  assert.match(summary, /Payment status is Paid/i);
  assert.match(summary, /Tracking number 9400111899223344556677/i);
  assert.match(summary, /Algebra 1/i);
  assert.match(summary, /Dallas/i);
});

test('buildVoiceOrderSummary mentions refunds when present', () => {
  const summary = buildVoiceOrderSummary({
    ...baseOrder,
    financialStatus: 'REFUNDED',
    refunds: [
      {
        createdAt: '2026-03-08T12:00:00.000Z',
        amount: '49.99',
        currency: 'USD',
        note: 'Customer request',
      },
    ],
  });
  assert.match(summary, /refund of 49\.99 USD was issued/i);
  assert.match(summary, /refund confirmation email was sent to jane@example\.com/i);
});

test('buildVoiceOrderSummary refund mentions card last 4 when available', () => {
  const summary = buildVoiceOrderSummary({
    ...baseOrder,
    financialStatus: 'REFUNDED',
    paymentCardLast4: '4242',
    paymentCardBrand: 'Visa',
    refunds: [
      {
        createdAt: '2026-03-08T12:00:00.000Z',
        amount: '49.99',
        currency: 'USD',
        note: null,
      },
    ],
  });
  assert.match(summary, /Visa card ending in 4242/i);
});
