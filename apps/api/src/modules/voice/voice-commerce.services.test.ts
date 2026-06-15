import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUBTOTAL_DISCLAIMER,
  buildSubtotalSpokenLine,
  sanitizeCustomerFacingText,
} from './utils/voice-agent-language.util';
import { findCatalogInventoryOverride } from './data/voice-catalog-overrides.data';
import { normalizeShippingMethod } from './services/voice-shipping.service';
import { FacilityApprovalService } from './services/facility-approval.service';
import { VoiceAddressUpdateService } from './services/voice-address-update.service';
import { VoiceEscalationService } from './services/voice-escalation.service';
import { VoicePricingService } from './services/voice-pricing.service';
import { VoiceCancellationService } from './services/voice-cancellation.service';
import { FacilityRestrictionService } from './services/facility-restriction.service';
import { VoiceCatalogService } from './services/voice-catalog.service';
import { VoiceCallDiagnosticsService } from './services/voice-call-diagnostics.service';
import { applyPrivacyToOrder, resolveVerificationFlags } from './utils/voice-order-privacy.util';
import type { VoiceOrderDetailDto } from './dto/get-order.dto';
import type { ExtendedOrderSnapshot } from './services/voice-order-lookup.service';
import { classifyOrderLineItems } from './utils/voice-order-enrichment.util';

const sampleOrder = (): VoiceOrderDetailDto => ({
  id: '1',
  orderNumber: '#1001',
  createdAt: '2025-01-01T00:00:00Z',
  financialStatus: 'PAID',
  fulfillmentStatus: 'UNFULFILLED',
  cancelledAt: null,
  cancelReason: null,
  totalPrice: '25.00',
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
  lineItems: [{ title: 'Test Book', quantity: 1, sku: 'SKU1', variantTitle: 'Paperback' }],
  fulfillments: [],
  refunds: [],
  paymentCardLast4: '4242',
  paymentCardBrand: 'Visa',
});

test('1. processing fee is never included in spoken response', () => {
  const out = sanitizeCustomerFacingText('Your processing fee is $2 and processing fees apply.');
  assert.doesNotMatch(out, /processing fee/i);
  assert.match(out, /order total/i);
});

test('2. subtotal always says without shipping', () => {
  const line = buildSubtotalSpokenLine('19.99');
  assert.match(line, /before shipping/i);
  assert.equal(SUBTOTAL_DISCLAIMER, 'Subtotal does not include shipping.');
  assert.match(line, new RegExp(SUBTOTAL_DISCLAIMER.replace(/\./g, '\\.')));
});

test('3. shipping cost is included when available', async () => {
  const pricing = new VoicePricingService({
    lookupOrder: async () => ({
      ...sampleOrder(),
      subtotalWithoutShipping: '20.00',
      shippingCost: '4.50',
      shippingMethodTitle: 'Media Mail',
      shippingCarrier: 'USPS',
      orderStatus: 'shipped',
      refundStatus: null,
      extendedLineItems: [],
      isShipped: true,
      isCancelled: false,
      isRefunded: false,
      note: null,
    }),
  } as never);

  const result = await pricing.calculatePricing({ orderNumber: '1001' });
  assert.equal(result.success, true);
  assert.equal(result.shipping_cost, '4.50');
  assert.match(result.suggested_response, /Shipping is/i);
});

test('4. shipping cost missing returns disclaimer', async () => {
  const pricing = new VoicePricingService({
    lookupOrder: async () => ({
      ...sampleOrder(),
      subtotalWithoutShipping: '20.00',
      shippingCost: null,
      shippingMethodTitle: null,
      shippingCarrier: null,
      orderStatus: 'open',
      refundStatus: null,
      extendedLineItems: [],
      isShipped: false,
      isCancelled: false,
      isRefunded: false,
      note: null,
      shippingAddress: null,
    }),
  } as never);

  const result = await pricing.calculatePricing({ orderNumber: '1001' });
  assert.equal(result.shipping_status, 'needs_address_or_method');
  assert.equal(result.subtotal_disclaimer, SUBTOTAL_DISCLAIMER);
  assert.match(result.suggested_response, /before shipping/i);
});

test('5. RED RIVER VENGEANCE returns out_of_stock', () => {
  const override = findCatalogInventoryOverride('RED RIVER VENGEANCE');
  assert.equal(override?.status, 'out_of_stock');
});

test('5b. catalog search override for RED RIVER VENGEANCE', async () => {
  const catalog = new VoiceCatalogService(
    { searchProduct: async () => ({ success: true, products: [] }) } as never,
    { resolveAgentContext: async () => ({ tenantId: 't', agentId: 'a' }) } as never,
  );
  const result = await catalog.searchCatalog({ query: 'RED RIVER VENGEANCE' });
  assert.equal(result.inventory_status, 'out_of_stock');
  assert.match(result.suggested_response, /not in stock/i);
});

test('6. shipped order returns Media Mail or Priority Mail', () => {
  assert.equal(normalizeShippingMethod('USPS Media Mail', 'USPS'), 'Media Mail');
  assert.equal(normalizeShippingMethod('Priority Mail Express', 'USPS'), 'Priority Mail');
});

test('7. facility approved list returns approved/not_approved/unknown', () => {
  const service = new FacilityApprovalService();
  const approved = service.checkFacilityApproval({ facilityName: 'San Quentin State Prison' });
  assert.equal(approved.status, 'approved');

  const restricted = service.checkFacilityApproval({ facilityName: 'Example Restricted Facility' });
  assert.equal(restricted.status, 'restricted');
});

test('8. unknown facility escalates', () => {
  const service = new FacilityApprovalService();
  const result = service.checkFacilityApproval({ facilityName: 'Totally Unknown Jail XYZ' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.escalate, true);
  assert.equal(result.escalation_reason, 'facility_approval_unknown');
});

test('9. address update returns Jessica email instructions', () => {
  const service = new VoiceAddressUpdateService({
    get: (key: string) => (key === 'JESSICA_SUPPORT_EMAIL' ? 'jessica@sureshotbooks.com' : undefined),
  } as never);
  const result = service.getAddressUpdateInstructions({ orderNumber: '1001' });
  assert.match(result.suggested_response, /jessica@sureshotbooks\.com/i);
  assert.match(result.suggested_response, /Jessica/i);
  assert.match(result.instructions, /email jessica@sureshotbooks\.com/i);
});

test('10. book not listed escalates to customer service', async () => {
  const catalog = new VoiceCatalogService(
    {
      searchProduct: async () => ({
        success: true,
        products: [],
      }),
    } as never,
    { resolveAgentContext: async () => ({ tenantId: 't', agentId: 'a' }) } as never,
  );
  const result = await catalog.searchCatalog({ query: 'Obscure Book Not In Catalog 99999' });
  assert.equal(result.match_type, 'not_found');
  assert.equal(result.escalate, true);
  assert.equal(result.escalation_reason, 'book_not_listed');
});

test('11. cancellation request checks order status first', async () => {
  const cancellation = new VoiceCancellationService({
    lookupOrder: async () => ({
      ...sampleOrder(),
      orderStatus: 'open',
      isShipped: false,
      isCancelled: false,
      isRefunded: false,
      extendedLineItems: [],
      subtotalWithoutShipping: '20',
      shippingCost: null,
      shippingMethodTitle: null,
      shippingCarrier: null,
      refundStatus: null,
      note: null,
    }),
  } as never);

  const result = await cancellation.checkCancellationEligibility({ orderNumber: '1001' });
  assert.equal(result.success, true);
  assert.equal(result.cancellation_eligible, true);
});

test('12. shipped order cannot be cancelled', async () => {
  const cancellation = new VoiceCancellationService({
    lookupOrder: async () => ({
      ...sampleOrder(),
      fulfillmentStatus: 'FULFILLED',
      orderStatus: 'shipped',
      isShipped: true,
      isCancelled: false,
      isRefunded: false,
      extendedLineItems: [],
      subtotalWithoutShipping: '20',
      shippingCost: '4',
      shippingMethodTitle: 'Media Mail',
      shippingCarrier: 'USPS',
      refundStatus: null,
      note: null,
      fulfillments: [
        {
          status: 'SUCCESS',
          displayStatus: 'Fulfilled',
          tracking: [{ company: 'USPS', number: '9400111111111111111111', url: null }],
          estimatedDeliveryAt: null,
          deliveredAt: null,
          inTransitAt: '2025-01-02T00:00:00Z',
        },
      ],
    }),
  } as never);

  const result = await cancellation.checkCancellationEligibility({ orderNumber: '1001' });
  assert.equal(result.cancellation_eligible, false);
  assert.match(result.suggested_response, /shipped/i);
  assert.equal(result.escalate, true);
});

test('13. one restricted book on order is identified', async () => {
  const restrictions = new FacilityRestrictionService(
    {
      lookupOrder: async () => ({
        ...sampleOrder(),
        shippingAddress: {
          name: 'Pelican Bay',
          address1: null,
          address2: null,
          city: 'Crescent City',
          provinceCode: 'CA',
          zip: '95531',
          countryCode: 'US',
        },
        extendedLineItems: [
          {
            title: 'Hardcover Bestseller',
            quantity: 1,
            sku: 'HC1',
            variantTitle: 'Hardcover',
            unfulfilledQuantity: 1,
            fulfillableQuantity: 1,
            productTags: [],
          },
        ],
        subtotalWithoutShipping: '20',
        shippingCost: null,
        shippingMethodTitle: null,
        shippingCarrier: null,
        orderStatus: 'open',
        refundStatus: null,
        isShipped: false,
        isCancelled: false,
        isRefunded: false,
        note: null,
      }),
    } as never,
    new FacilityApprovalService(),
  );

  const result = await restrictions.checkOrderFacilityRestrictions({
    orderNumber: '1001',
    facilityName: 'Pelican Bay State Prison',
  });
  assert.equal(result.restricted_items.length, 1);
  assert.equal(result.restricted_items[0].status, 'not_accepted');
  assert.match(result.restricted_items[0].reason, /Hardcover/i);
});

test('13b. processing fee line is excluded from facility restriction items', async () => {
  const restrictions = new FacilityRestrictionService(
    {
      lookupOrder: async () => ({
        ...sampleOrder(),
        extendedLineItems: [
          {
            title: 'Paperback Novel',
            quantity: 1,
            sku: 'PB1',
            variantTitle: 'Paperback',
            unfulfilledQuantity: 1,
            fulfillableQuantity: 1,
            productTags: [],
          },
          {
            title: 'Processing Fee',
            quantity: 1,
            sku: null,
            variantTitle: null,
            unfulfilledQuantity: 0,
            fulfillableQuantity: 0,
            productTags: [],
          },
        ],
        subtotalWithoutShipping: '20',
        shippingCost: null,
        shippingMethodTitle: null,
        shippingCarrier: null,
        orderStatus: 'open',
        refundStatus: null,
        isShipped: false,
        isCancelled: false,
        isRefunded: false,
        note: null,
      }),
    } as never,
    new FacilityApprovalService(),
  );

  const result = await restrictions.checkOrderFacilityRestrictions({
    orderNumber: '1001',
    facilityName: 'San Quentin State Prison',
  });
  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /processing fee/i);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.title, 'Paperback Novel');
});

test('14. backorder items are explained correctly', () => {
  const order = {
    note: 'customer ok with backorder',
    fulfillmentStatus: 'UNFULFILLED',
  } as ExtendedOrderSnapshot;
  const { backorder_items } = classifyOrderLineItems(
    [
      {
        title: 'Delayed Title',
        quantity: 1,
        sku: 'B1',
        variantTitle: null,
        unfulfilledQuantity: 1,
        fulfillableQuantity: 0,
        productTags: [],
      },
    ],
    order,
  );
  assert.equal(backorder_items.length, 1);
  assert.equal(backorder_items[0].status, 'backorder');
  assert.match(backorder_items[0].reason, /backorder/i);
});

test('15. no full PII is returned to ElevenLabs without full verification', () => {
  const order = sampleOrder();
  const verification = resolveVerificationFlags({
    callerPhone: '+19999999999',
    customerPhone: order.customerPhone,
    orderFound: true,
  });
  assert.equal(verification.verified_level, 'partial');
  const safe = applyPrivacyToOrder(order, verification);
  assert.equal(safe.customerEmail, undefined);
  assert.equal(safe.customerName, undefined);
  assert.equal(safe.shippingAddress, undefined);
  // Partial verification may expose last4 only — never full card or full email.
  assert.notEqual(safe.paymentCardLast4, '4242424242424242');
});

test('16. tool failures return safe fallback', async () => {
  const catalog = new VoiceCatalogService(
    {
      searchProduct: async () => {
        throw new Error('shopify down');
      },
    } as never,
    { resolveAgentContext: async () => ({ tenantId: 't', agentId: 'a' }) } as never,
  );
  const result = await catalog.searchCatalog({ query: 'Some Book' });
  assert.equal(result.success, false);
  assert.match(result.suggested_response, /customer service/i);
  assert.equal(result.escalate, true);
});

test('escalation service returns escalation_id', () => {
  const service = new VoiceEscalationService({ get: () => undefined } as never);
  const result = service.escalate({ reason: 'book_not_listed', orderNumber: '1001' });
  assert.equal(result.success, true);
  assert.match(result.escalation_id, /^esc_/);
});

test('call diagnostics records call_started', () => {
  const diag = new VoiceCallDiagnosticsService();
  diag.recordCallStarted({ callSid: 'CA123', twilioCallStatus: 'ringing' });
  const snapshot = diag.getDiagnostics('CA123');
  assert.ok(snapshot);
  assert.equal(snapshot?.twilio_call_sid, 'CA123');
  assert.equal(snapshot?.twiml_sent, false);
  assert.equal(snapshot?.likely_failure_stage, 'inbound_received');
});
