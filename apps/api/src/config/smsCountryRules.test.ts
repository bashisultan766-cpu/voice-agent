import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { detectPhoneCountry, evaluateSmsCountryRules } from './smsCountryRules';

describe('smsCountryRules', () => {
  test('detects US from E.164', () => {
    assert.equal(detectPhoneCountry('+12025551234'), 'US');
  });

  test('blocks US when A2P not registered', () => {
    const decision = evaluateSmsCountryRules('+12025551234', {
      a2p10dlcRegistered: false,
      enableInternationalSms: true,
      allowedCountries: [],
      blockedCountries: [],
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.logEvent, 'sms_skipped_country_restricted');
  });

  test('allows US when A2P registered', () => {
    const decision = evaluateSmsCountryRules('+12025551234', {
      a2p10dlcRegistered: true,
      enableInternationalSms: true,
      allowedCountries: [],
      blockedCountries: [],
    });
    assert.equal(decision.allowed, true);
  });

  test('blocks international when disabled', () => {
    const decision = evaluateSmsCountryRules('+442071234567', {
      a2p10dlcRegistered: true,
      enableInternationalSms: false,
      allowedCountries: [],
      blockedCountries: [],
    });
    assert.equal(decision.allowed, false);
  });

  test('respects allowlist', () => {
    const decision = evaluateSmsCountryRules('+442071234567', {
      a2p10dlcRegistered: true,
      enableInternationalSms: true,
      allowedCountries: ['GB'],
      blockedCountries: [],
    });
    assert.equal(decision.allowed, true);

    const pk = evaluateSmsCountryRules('+923001234567', {
      a2p10dlcRegistered: true,
      enableInternationalSms: true,
      allowedCountries: ['GB'],
      blockedCountries: [],
    });
    assert.equal(pk.allowed, false);
  });

  test('respects blocklist', () => {
    const decision = evaluateSmsCountryRules('+12025551234', {
      a2p10dlcRegistered: true,
      enableInternationalSms: true,
      allowedCountries: [],
      blockedCountries: ['US'],
    });
    assert.equal(decision.allowed, false);
  });
});
