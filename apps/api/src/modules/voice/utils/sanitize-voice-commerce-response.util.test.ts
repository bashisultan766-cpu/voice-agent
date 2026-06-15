import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isHiddenInternalLineItem,
  partitionCustomerFacingLineItems,
  sanitizeVoiceCommerceResponse,
  stripForbiddenCustomerPhrases,
} from './sanitize-voice-commerce-response.util';

const book = { title: 'Algebra 1', quantity: 1, sku: '9781', variantTitle: null };
const fee = { title: 'Processing Fee', quantity: 1, sku: null, variantTitle: null };
const feeLower = { title: 'processing fee', quantity: 1, sku: null, variantTitle: null };

test('isHiddenInternalLineItem matches case variants', () => {
  assert.equal(isHiddenInternalLineItem('Processing Fee'), true);
  assert.equal(isHiddenInternalLineItem('processing fee'), true);
  assert.equal(isHiddenInternalLineItem('PROCESSING FEE'), true);
  assert.equal(isHiddenInternalLineItem('Algebra 1'), false);
});

test('partitionCustomerFacingLineItems keeps books and counts hidden items', () => {
  const { customerFacing, hiddenCount } = partitionCustomerFacingLineItems([book, fee, feeLower]);
  assert.equal(hiddenCount, 2);
  assert.equal(customerFacing.length, 1);
  assert.equal(customerFacing[0]?.title, 'Algebra 1');
});

test('stripForbiddenCustomerPhrases removes phrase entirely', () => {
  const out = stripForbiddenCustomerPhrases('Includes Processing Fee and shipping.');
  assert.doesNotMatch(out, /processing fee/i);
  assert.match(out, /shipping/i);
});

test('sanitizeVoiceCommerceResponse removes processing fee from nested get-order shape', () => {
  const payload = sanitizeVoiceCommerceResponse({
    success: true,
    found: true,
    voiceSummary: 'Order #47569 with Processing Fee applied.',
    suggested_response: 'Your Processing Fee is included.',
    order: {
      lineItems: [book, fee],
    },
    enriched: {
      items: [book, fee],
      subtotal_without_shipping: '45.00',
      shipping_cost: '4.50',
    },
    customer_facing_items: [book, fee],
    refundSummary: {
      order_number: '#47569',
      refund_status: 'REFUNDED',
    },
  });

  const json = JSON.stringify(payload);
  assert.doesNotMatch(json, /processing fee/i);
  assert.equal(payload.order?.lineItems.length, 1);
  assert.equal(payload.enriched?.items.length, 1);
  assert.equal(payload.customer_facing_items?.length, 1);
  assert.equal(payload.customer_facing_items?.[0]?.title, 'Algebra 1');
  assert.equal(payload.enriched?.subtotal_without_shipping, '45.00');
  assert.equal(payload.enriched?.shipping_cost, '4.50');
});
