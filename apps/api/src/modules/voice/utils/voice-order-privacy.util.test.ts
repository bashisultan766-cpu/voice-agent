import test from 'node:test';
import assert from 'node:assert/strict';
import type { VoiceOrderDetailDto } from '../dto/get-order.dto';
import {
  applyPrivacyToOrder,
  buildMaskedOrderFields,
  buildRefundOrderSummary,
  resolveVerificationFlags,
} from './voice-order-privacy.util';

function sampleOrder(overrides: Partial<VoiceOrderDetailDto> = {}): VoiceOrderDetailDto {
  return {
    id: '1',
    orderNumber: '#1010',
    createdAt: '2025-01-15T12:00:00.000Z',
    financialStatus: 'REFUNDED',
    fulfillmentStatus: 'FULFILLED',
    cancelledAt: null,
    cancelReason: null,
    totalPrice: '29.99',
    currency: 'USD',
    customerName: 'Jane Doe',
    customerEmail: 'jane@example.com',
    customerPhone: '+15551234567',
    shippingAddress: {
      name: 'Jane Doe',
      address1: '123 Main St',
      address2: null,
      city: 'Austin',
      provinceCode: 'TX',
      zip: '78701',
      countryCode: 'US',
    },
    lineItems: [{ title: 'Book', quantity: 1, sku: null, variantTitle: null }],
    fulfillments: [],
    refunds: [
      {
        createdAt: '2025-01-20T12:00:00.000Z',
        amount: '29.99',
        currency: 'USD',
        note: null,
      },
    ],
    paymentCardLast4: '4242',
    paymentCardBrand: 'Visa',
    ...overrides,
  };
}

test('partial verification masks sensitive fields and blocks full address', () => {
  const order = sampleOrder();
  const verification = resolveVerificationFlags({
    callerPhone: '+15559876543',
    customerPhone: order.customerPhone,
    orderFound: true,
  });
  assert.equal(verification.verified_level, 'partial');
  assert.equal(verification.can_share_address, false);
  assert.equal(verification.can_share_email, false);

  const masked = buildMaskedOrderFields(order, verification);
  assert.equal(masked.masked_email, 'j***@example.com');
  assert.equal(masked.last4_card_or_id, '4242');
  assert.equal(masked.masked_phone, '***4567');
  assert.match(masked.partial_address ?? '', /Austin/);

  const safe = applyPrivacyToOrder(order, verification);
  assert.equal(safe.customerEmail, undefined);
  assert.equal(safe.shippingAddress, undefined);
  assert.equal(safe.paymentCardLast4, '4242');
});

test('full verification when caller phone matches customer', () => {
  const order = sampleOrder();
  const verification = resolveVerificationFlags({
    callerPhone: '+1 (555) 123-4567',
    customerPhone: order.customerPhone,
    orderFound: true,
  });
  assert.equal(verification.phone_matches_customer, true);
  assert.equal(verification.verified_level, 'full');
  assert.equal(verification.can_share_address, true);
  assert.equal(verification.can_share_email, true);

  const safe = applyPrivacyToOrder(order, verification);
  assert.equal(safe.customerEmail, 'jane@example.com');
  assert.equal(safe.shippingAddress?.address1, '123 Main St');
});

test('refund summary returns masked fields only', () => {
  const order = sampleOrder();
  const verification = resolveVerificationFlags({
    callerPhone: '+15559876543',
    customerPhone: order.customerPhone,
    orderFound: true,
  });
  const masked = buildMaskedOrderFields(order, verification);
  const refund = buildRefundOrderSummary(order, verification, masked);

  assert.ok(refund);
  assert.equal(refund?.order_number, '#1010');
  assert.equal(refund?.booking_date, '2025-01-15');
  assert.equal(refund?.refund_amount, '29.99');
  assert.equal(refund?.refund_date, '2025-01-20');
  assert.equal(refund?.masked_email, 'j***@example.com');
  assert.equal(refund?.last4_card_or_id, '4242');
  assert.equal(refund?.customer_verification_status, 'partial');
});
