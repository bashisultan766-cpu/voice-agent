/**
 * SendPaymentLink email gate — format validation, typo suggestions, confirmation, debug envelope.
 */

import { normalizeSpokenEmail } from '../../calls/runtime/spoken-email-normalizer.util';
import {
  detectDomainTypo,
  extractEmailDomain,
  isDisposableEmailDomain,
  suggestEmailTypo,
} from '../../calls/runtime/voice-email-enterprise-validation.util';

/** Inbox-safe payment-link email format (voice + tool payloads). */
export const PAYMENT_EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export type PaymentEmailGateAction = 'SendPaymentLink' | 'AskForEmail' | 'SuggestCorrection';

export type PaymentEmailGateDebug = {
  action: PaymentEmailGateAction;
  customerEmail: string;
  confirmationRequired: boolean;
  error: string | null;
  note: string;
};

export type PaymentEmailGateResult = {
  allowed: boolean;
  normalizedEmail: string;
  agentMessage: string;
  debug: PaymentEmailGateDebug;
  possiblyInvalid: boolean;
};

export const EMAIL_POSSIBLY_INVALID_PROMPT =
  'I noticed your email might be incorrect. Please repeat it slowly.';

export const EMAIL_UNRECOGNIZED_DOMAIN_PROMPT =
  'I could not verify that email domain. Please spell your email address again, or provide a different email you use regularly.';

const WELL_KNOWN_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
  'zoho.com',
  'mail.com',
  'gmx.com',
  'yandex.com',
  'sureshotbooks.com',
  'sureshot.com',
]);

export function isPossiblyInvalidEmailDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  if (!d || !d.includes('.')) return true;
  if (WELL_KNOWN_EMAIL_DOMAINS.has(d)) return false;
  if (detectDomainTypo(d)) return false;
  const labels = d.split('.');
  const tld = labels[labels.length - 1] ?? '';
  if (tld.length < 2 || tld.length > 24) return true;
  if (/^\d+$/.test(tld)) return true;
  return true;
}

export function buildPaymentEmailTypoSuggestionPrompt(correctedEmail: string): string {
  return `Did you mean ${correctedEmail}?`;
}

export function buildPaymentEmailGateDebug(partial: PaymentEmailGateDebug): PaymentEmailGateDebug {
  return {
    action: partial.action,
    customerEmail: partial.customerEmail,
    confirmationRequired: partial.confirmationRequired,
    error: partial.error,
    note: partial.note,
  };
}

export function evaluatePaymentEmailGate(input: {
  rawEmail: string;
  emailConfirmed?: boolean;
  sessionConfirmedEmail?: string | null;
  sessionConfirmationState?: 'pending' | 'confirmed' | 'rejected' | null;
}): PaymentEmailGateResult {
  const normalized = normalizeSpokenEmail(input.rawEmail).trim().toLowerCase();
  const baseDebug = (overrides: PaymentEmailGateDebug): PaymentEmailGateDebug =>
    buildPaymentEmailGateDebug(overrides);

  if (!normalized || !normalized.includes('@')) {
    return {
      allowed: false,
      normalizedEmail: normalized,
      agentMessage: EMAIL_POSSIBLY_INVALID_PROMPT,
      possiblyInvalid: true,
      debug: baseDebug({
        action: 'AskForEmail',
        customerEmail: normalized,
        confirmationRequired: true,
        error: 'missing_or_malformed_email',
        note: 'Email missing @ or empty after normalization.',
      }),
    };
  }

  if (!PAYMENT_EMAIL_REGEX.test(normalized)) {
    return {
      allowed: false,
      normalizedEmail: normalized,
      agentMessage: EMAIL_POSSIBLY_INVALID_PROMPT,
      possiblyInvalid: true,
      debug: baseDebug({
        action: 'AskForEmail',
        customerEmail: normalized,
        confirmationRequired: true,
        error: 'invalid_format',
        note: 'Email failed PAYMENT_EMAIL_REGEX validation.',
      }),
    };
  }

  const domain = extractEmailDomain(normalized);
  if (!domain) {
    return {
      allowed: false,
      normalizedEmail: normalized,
      agentMessage: EMAIL_POSSIBLY_INVALID_PROMPT,
      possiblyInvalid: true,
      debug: baseDebug({
        action: 'AskForEmail',
        customerEmail: normalized,
        confirmationRequired: true,
        error: 'invalid_domain',
        note: 'Could not parse domain from email.',
      }),
    };
  }

  if (isDisposableEmailDomain(domain)) {
    return {
      allowed: false,
      normalizedEmail: normalized,
      agentMessage: EMAIL_UNRECOGNIZED_DOMAIN_PROMPT,
      possiblyInvalid: true,
      debug: baseDebug({
        action: 'AskForEmail',
        customerEmail: normalized,
        confirmationRequired: true,
        error: 'disposable_domain',
        note: 'Disposable / temporary email domain blocked.',
      }),
    };
  }

  const typo = suggestEmailTypo(normalized);
  if (typo) {
    return {
      allowed: false,
      normalizedEmail: normalized,
      agentMessage: buildPaymentEmailTypoSuggestionPrompt(typo.correctedEmail),
      possiblyInvalid: false,
      debug: baseDebug({
        action: 'SuggestCorrection',
        customerEmail: normalized,
        confirmationRequired: true,
        error: 'domain_typo',
        note: `Suggested domain correction ${typo.fromDomain} → ${typo.toDomain}.`,
      }),
    };
  }

  const possiblyInvalid = isPossiblyInvalidEmailDomain(domain);
  if (possiblyInvalid) {
    return {
      allowed: false,
      normalizedEmail: normalized,
      agentMessage: EMAIL_UNRECOGNIZED_DOMAIN_PROMPT,
      possiblyInvalid: true,
      debug: baseDebug({
        action: 'AskForEmail',
        customerEmail: normalized,
        confirmationRequired: true,
        error: 'unrecognized_domain',
        note: `Domain "${domain}" is not in the known-provider list.`,
      }),
    };
  }

  const sessionEmail = input.sessionConfirmedEmail?.trim().toLowerCase();
  const sessionConfirmed = input.sessionConfirmationState === 'confirmed';
  const toolConfirmed = input.emailConfirmed === true;
  const emailMatchesSession = sessionEmail ? sessionEmail === normalized : false;

  if (!toolConfirmed && !(sessionConfirmed && emailMatchesSession)) {
    return {
      allowed: false,
      normalizedEmail: normalized,
      agentMessage: EMAIL_POSSIBLY_INVALID_PROMPT,
      possiblyInvalid: false,
      debug: baseDebug({
        action: 'AskForEmail',
        customerEmail: normalized,
        confirmationRequired: true,
        error: 'email_not_confirmed',
        note: sessionConfirmed
          ? 'Session confirmed a different email than the tool payload.'
          : 'Customer must confirm email before SendPaymentLink.',
      }),
    };
  }

  return {
    allowed: true,
    normalizedEmail: normalized,
    agentMessage: '',
    possiblyInvalid: false,
    debug: baseDebug({
      action: 'SendPaymentLink',
      customerEmail: normalized,
      confirmationRequired: false,
      error: null,
      note: toolConfirmed
        ? 'Email confirmed via tool flag.'
        : 'Email confirmed via call session state.',
    }),
  };
}

export function buildSendPaymentLinkFailureLog(input: {
  customerEmail: string;
  errorMessage: string;
  deliveryAttemptId?: string | null;
  timestamp?: string;
}): Record<string, unknown> {
  return {
    event: 'voice.payment.send_payment_link_failed',
    customerEmail: input.customerEmail,
    errorMessage: input.errorMessage.slice(0, 500),
    timestamp: input.timestamp ?? new Date().toISOString(),
    deliveryAttemptId: input.deliveryAttemptId ?? null,
  };
}

export function buildEmailSentLog(input: {
  customerEmail: string;
  emailConfirmed: boolean;
  deliveryAttemptId?: string | null;
  draftOrderId?: string;
}): Record<string, unknown> {
  return {
    event: 'email_sent',
    customerEmail: input.customerEmail,
    emailConfirmed: input.emailConfirmed,
    deliveryAttemptId: input.deliveryAttemptId ?? null,
    ...(input.draftOrderId ? { draftOrderId: input.draftOrderId } : {}),
    timestamp: new Date().toISOString(),
  };
}
