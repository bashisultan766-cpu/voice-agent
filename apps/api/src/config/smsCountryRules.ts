import { parsePhoneNumberFromString } from 'libphonenumber-js';

export type SmsCountryRulesEnv = {
  a2p10dlcRegistered: boolean;
  enableInternationalSms: boolean;
  allowedCountries: string[];
  blockedCountries: string[];
};

export type SmsCountryDecision = {
  allowed: boolean;
  country: string | null;
  reason?: string;
  logEvent?: 'sms_skipped_country_restricted';
};

const NANP_COUNTRIES = new Set(['US', 'CA']);

function parseCountryList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));
}

export function readSmsCountryRulesFromEnv(env: NodeJS.ProcessEnv = process.env): SmsCountryRulesEnv {
  return {
    a2p10dlcRegistered: env.A2P_10DLC_REGISTERED === 'true',
    enableInternationalSms: env.ENABLE_INTERNATIONAL_SMS !== 'false',
    allowedCountries: parseCountryList(env.SMS_ALLOWED_COUNTRIES),
    blockedCountries: parseCountryList(env.SMS_BLOCKED_COUNTRIES),
  };
}

/** Detect ISO 3166-1 alpha-2 country from E.164 or national phone input. */
export function detectPhoneCountry(phone: string): string | null {
  const trimmed = phone.trim();
  if (!trimmed) return null;
  try {
    const parsed = parsePhoneNumberFromString(trimmed);
    if (parsed?.country) return parsed.country;
    const withPlus = trimmed.startsWith('+') ? trimmed : `+${trimmed.replace(/\D/g, '')}`;
    const retry = parsePhoneNumberFromString(withPlus);
    return retry?.country ?? null;
  } catch {
    return null;
  }
}

/**
 * Country-based SMS gate for Twilio.
 * - US/CA require A2P_10DLC_REGISTERED=true
 * - Other countries require ENABLE_INTERNATIONAL_SMS=true
 * - Optional allowlist / blocklist via env
 */
export function evaluateSmsCountryRules(
  phone: string,
  rules: SmsCountryRulesEnv = readSmsCountryRulesFromEnv(),
): SmsCountryDecision {
  const country = detectPhoneCountry(phone);
  if (!country) {
    return {
      allowed: false,
      country: null,
      reason: 'Could not detect country from phone number.',
      logEvent: 'sms_skipped_country_restricted',
    };
  }

  if (rules.blockedCountries.includes(country)) {
    return {
      allowed: false,
      country,
      reason: `Country ${country} is blocked for SMS.`,
      logEvent: 'sms_skipped_country_restricted',
    };
  }

  if (rules.allowedCountries.length > 0 && !rules.allowedCountries.includes(country)) {
    return {
      allowed: false,
      country,
      reason: `Country ${country} is not in SMS allowlist.`,
      logEvent: 'sms_skipped_country_restricted',
    };
  }

  if (NANP_COUNTRIES.has(country)) {
    if (!rules.a2p10dlcRegistered) {
      return {
        allowed: false,
        country,
        reason: 'US/Canada SMS requires A2P 10DLC registration.',
        logEvent: 'sms_skipped_country_restricted',
      };
    }
    return { allowed: true, country };
  }

  if (!rules.enableInternationalSms) {
    return {
      allowed: false,
      country,
      reason: 'International SMS is disabled.',
      logEvent: 'sms_skipped_country_restricted',
    };
  }

  return { allowed: true, country };
}
