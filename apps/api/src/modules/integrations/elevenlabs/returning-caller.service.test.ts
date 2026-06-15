import test from 'node:test';
import assert from 'node:assert/strict';
import { ReturningCallerService } from './returning-caller.service';
import { GENERIC_FIRST_MESSAGE } from './utils/returning-caller-personalization.util';

test('customer lookup failure does not throw and returns generic greeting', async () => {
  const service = new ReturningCallerService(
    {
      resolveCallerIdentity: async () => {
        throw new Error('database unavailable');
      },
      getCallerProfileByPhone: async () => null,
      touchInboundCallHistory: async () => undefined,
    } as never,
    { findCustomerByPhone: async () => null } as never,
    { getCallerInfo: async () => null } as never,
  );

  const result = await service.prepareInboundCall({
    rawFrom: '+15551234567',
    callSid: 'CA_FAIL',
  });

  assert.equal(result.lookup.callerRecognized, false);
  assert.equal(result.initiation.personalized, false);
  assert.equal(result.initiation.firstMessage, GENERIC_FIRST_MESSAGE);
});

test('known returning caller is prepared with partial verification', async () => {
  const service = new ReturningCallerService(
    {
      resolveCallerIdentity: async () => ({
        phoneNormalized: '+15551234567',
        displayName: 'Washi Khan',
        firstName: 'Washi',
        lastName: 'Khan',
        email: 'washi@example.com',
        isReturningCaller: true,
        priorCallCount: 4,
        identitySource: 'shopify_orders',
      }),
      getCallerProfileByPhone: async () => ({
        metadata: {
          call_history: {
            first_seen_at: '2025-01-01T00:00:00.000Z',
            last_seen_at: '2025-01-02T00:00:00.000Z',
            total_calls: 4,
            last_call_sid: 'CA_OLD',
            last_order_number: '#1042',
            last_intent: 'order_lookup',
            last_call_summary: 'Asked about shipment',
          },
        },
        displayName: 'Washi Khan',
        externalId: 'gid://shopify/Customer/9',
      }),
      touchInboundCallHistory: async () => undefined,
    } as never,
    {
      findCustomerByPhone: async () => ({
        customerId: 'gid://shopify/Customer/9',
        displayName: 'Washi Khan',
        firstName: 'Washi',
        lastName: 'Khan',
        email: 'washi@example.com',
        ordersCount: 2,
        lastOrderDate: null,
        purchases: [{ title: 'Book', quantity: 1, orderName: '#1042', purchasedAt: null }],
      }),
    } as never,
    { getCallerInfo: async () => null } as never,
  );

  const result = await service.prepareInboundCall({
    rawFrom: '+15551234567',
    callSid: 'CA_OK',
  });

  assert.equal(result.lookup.callerRecognized, true);
  assert.equal(result.lookup.customerFirstName, 'Washi');
  assert.equal(result.lookup.callerPhoneVerified, 'partial');
  assert.equal(result.initiation.personalized, true);
  assert.match(result.initiation.firstMessage, /Hi Washi/);
  assert.equal(result.initiation.dynamicVariables.total_previous_calls, '4');
  assert.equal(result.initiation.dynamicVariables.last_order_number, '#1042');
  assert.doesNotMatch(JSON.stringify(result.initiation.dynamicVariables), /washi@example\.com/);
});
