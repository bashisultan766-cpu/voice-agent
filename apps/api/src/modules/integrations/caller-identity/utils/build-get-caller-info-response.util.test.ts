import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildGetCallerInfoResponse } from './build-get-caller-info-response.util';

describe('buildGetCallerInfoResponse', () => {
  test('builds returning caller greeting with name', () => {
    const response = buildGetCallerInfoResponse({
      phoneNumber: '+12515551234',
      threeCxConfigured: true,
      contact: {
        id: 'c1',
        firstName: 'Justin',
        lastName: 'Smith',
        displayName: 'Justin Smith',
        email: 'justin@example.com',
        company: 'SureShot',
        phones: ['+12515551234'],
        raw: {},
      },
      callHistory: [
        {
          segmentId: 'seg-1',
          startedAt: '2026-05-01T12:00:00.000Z',
          direction: 'Inbound',
          srcDisplayName: 'Justin Smith',
          dstDisplayName: 'Eric',
          srcDn: '+12515551234',
          dstDn: '100',
          durationSeconds: 120,
          answered: true,
          recordingId: 'rec-1',
          raw: {},
        },
      ],
      recordings: [],
      recordingUrls: ['https://api.example.com/api/integrations/3cx/recordings/rec-1/download'],
      pastPurchases: [
        { title: 'Atomic Habits', quantity: 1, price: '18.99', purchased_at: '2026-04-10T10:00:00.000Z' },
      ],
      totalPastOrders: 1,
      lastPurchaseDate: '2026-04-10T10:00:00.000Z',
      source: 'three_cx_api',
    });

    assert.equal(response.exists, true);
    assert.equal(response.first_name, 'Justin');
    assert.equal(response.is_returning_caller, true);
    assert.equal(response.call_count, 1);
    assert.match(response.greeting_hint, /Justin/i);
    assert.match(response.greeting_hint, /Atomic Habits/i);
    assert.equal(response.past_purchases.length, 1);
    assert.equal(response.should_ask_for_name, false);
  });

  test('past purchases alone mark caller as returning', () => {
    const response = buildGetCallerInfoResponse({
      phoneNumber: '+12515550000',
      threeCxConfigured: false,
      contact: null,
      callHistory: [],
      recordings: [],
      recordingUrls: [],
      pastPurchases: [
        { title: 'Deep Work', quantity: 1, price: null, purchased_at: null },
      ],
      totalPastOrders: 1,
      source: 'local_cache',
    });

    assert.equal(response.is_returning_caller, true);
    assert.match(response.greeting_hint, /Deep Work/i);
  });

  test('flags unknown caller for name capture', () => {
    const response = buildGetCallerInfoResponse({
      phoneNumber: '+12519998888',
      threeCxConfigured: true,
      contact: null,
      callHistory: [],
      recordings: [],
      recordingUrls: [],
      source: 'none',
    });

    assert.equal(response.exists, false);
    assert.equal(response.should_ask_for_name, true);
    assert.match(response.greeting_hint, /Ask for their name/i);
  });
});
