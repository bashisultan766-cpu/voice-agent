import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceFacilityLinkService } from './voice-facility-link.service';

test('createSecureCompletionLink builds signed https URL', () => {
  const service = new VoiceFacilityLinkService(
    {
      get: (key: string) => {
        if (key === 'FACILITY_COMPLETION_BASE_URL') return 'https://api.sureshot.test';
        if (key === 'FACILITY_LINK_SIGNING_SECRET') return 'test-secret';
        return undefined;
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const link = service.createSecureCompletionLink('#1010', 'inmate@facility.test');
  const url = new URL(link);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.pathname, '/facility/complete');
  assert.equal(url.searchParams.get('order'), '#1010');
  assert.equal(url.searchParams.get('email'), 'inmate@facility.test');
  assert.ok(url.searchParams.get('token'));
});
