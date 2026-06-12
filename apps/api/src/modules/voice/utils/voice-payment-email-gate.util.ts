/**
 * SendPaymentLink email gate — format validation, typo suggestions, confirmation, debug envelope.
 */

import { coerceBoolean } from '../../../common/utils/coerce-boolean.util';
import {
  normalizeSpokenEmail,
  VOICE_EMAIL_REGEX,
} from '../../calls/runtime/spoken-email-normalizer.util';
import {
  extractEmailDomain,
  suggestEmailTypo,
} from '../../calls/runtime/voice-email-enterprise-validation.util';

/** Same regex as voice capture — accepts Gmail and custom company domains consistently. */
export const PAYMENT_EMAIL_REGEX = VOICE_EMAIL_REGEX;

export type PaymentEmailGateAction = 'SendPaymentLink' | 'AskForEmail' | 'SuggestCorrection';

export type PaymentEmailGateDebug = {
  action: PaymentEmailGateAction;
  customerEmail: string;
  confirmationRequired: boolean;
  error: string | null;
  note: string;
};

export type PaymentEmailRejectionLog = {
  originalEmail: string;
  normalizedEmail: string;
  validationResult: string;
  domain: string | null;
  validationSource: 'internal_email_gate';
};

export type PaymentEmailGateResult = {
  allowed: boolean;
  normalizedEmail: string;
  agentMessage: string;
  debug: PaymentEmailGateDebug;
  possiblyInvalid: boolean;
  rejectionLog?: PaymentEmailRejectionLog;
};

export const EMAIL_POSSIBLY_INVALID_PROMPT =
  'I noticed your email might be incorrect. Please repeat it slowly.';

export const EMAIL_CONFIRMATION_REQUIRED_PROMPT =
  'Please confirm your email address before I send the payment link.';

/** ASCII hostname label — allows company and custom domains (e.g. shoreshortbooks.com). */
const DOMAIN_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isPossiblyInvalidEmailDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  if (!d || !d.includes('.')) return true;

  const labels = d.split('.');
  if (labels.some((label) => !label || label.length > 63)) return true;

  const tld = labels[labels.length - 1] ?? '';
  if (tld.length < 2 || tld.length > 24) return true;
  if (!/^[a-z]+$/.test(tld)) return true;

  return !labels.every((label) => DOMAIN_LABEL_REGEX.test(label));
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

export function buildPaymentEmailRejectionLog(input: {
  originalEmail: string;
  normalizedEmail: string;
  validationResult: string;
  domain?: string | null;
}): PaymentEmailRejectionLog {
  const normalized = input.normalizedEmail.trim().toLowerCase();
  return {
    originalEmail: input.originalEmail,
    normalizedEmail: normalized,
    validationResult: input.validationResult,
    domain: input.domain ?? extractEmailDomain(normalized),
    validationSource: 'internal_email_gate',
  };
}

function rejectGate(
  input: {
    rawEmail: string;
    normalizedEmail: string;
    agentMessage: string;
    possiblyInvalid: boolean;
    debug: PaymentEmailGateDebug;
    validationResult: string;
    domain?: string | null;
  },
): PaymentEmailGateResult {
  return {
    allowed: false,
    normalizedEmail: input.normalizedEmail,
    agentMessage: input.agentMessage,
    possiblyInvalid: input.possiblyInvalid,
    debug: input.debug,
    rejectionLog: buildPaymentEmailRejectionLog({
      originalEmail: input.rawEmail,
      normalizedEmail: input.normalizedEmail,
      validationResult: input.validationResult,
      domain: input.domain,
    }),
  };
}

export function evaluatePaymentEmailGate(input: {
  rawEmail: string;
  /** boolean or tool string forms ("true", "1", "yes"). */
  emailConfirmed?: boolean | string | number;
  sessionConfirmedEmail?: string | null;
  sessionConfirmationState?: 'pending' | 'confirmed' | 'rejected' | null;
}): PaymentEmailGateResult {
  const normalized = normalizeSpokenEmail(input.rawEmail).trim().toLowerCase();
  const baseDebug = (overrides: PaymentEmailGateDebug): PaymentEmailGateDebug =>
    buildPaymentEmailGateDebug(overrides);

  if (!normalized || !normalized.includes('@')) {
    return rejectGate({
      rawEmail: input.rawEmail,
      normalizedEmail: normalized,
      agentMessage: EMAIL_POSSIBLY_INVALID_PROMPT,
      possiblyInvalid: true,
      validationResult: 'missing_or_malformed_email',
      debug: baseDebug({
        action: 'AskForEmail',
        customerEmail: normalized,
        confirmationRequired: true,
        error: 'missing_or_malformed_email',
        note: 'Email missing @ or empty after normalization.',
      }),
    });
  }

  if (!PAYMENT_EMAIL_REGEX.test(normalized)) {
    return rejectGate({
      rawEmail: input.rawEmail,
      normalizedEmail: normalized,
      agentMessage: EMAIL_POSSIBLY_INVALID_PROMPT,
      possiblyInvalid: true,
      validationResult: 'invalid_format',
      debug: baseDebug({
        action: 'AskForEmail',
        customerEmail: normalized,
        confirmationRequired: true,
        error: 'invalid_format',
        note: 'Email failed PAYMENT_EMAIL_REGEX validation.',
      }),
    });
  }

  const domain = extractEmailDomain(normalized);
  if (!domain) {
    return rejectGate({
      rawEmail: input.rawEmail,
      normalizedEmail: normalized,
      agentMessage: EMAIL_POSSIBLY_INVALID_PROMPT,
      possiblyInvalid: true,
      validationResult: 'invalid_domain',
      debug: baseDebug({
        action: 'AskForEmail',
        customerEmail: normalized,
        confirmationRequired: true,
        error: 'invalid_domain',
        note: 'Could not parse domain from email.',
      }),
    });
  }

  const typo = suggestEmailTypo(normalized);
  if (typo) {
    return rejectGate({
      rawEmail: input.rawEmail,
      normalizedEmail: normalized,
      agentMessage: buildPaymentEmailTypoSuggestionPrompt(typo.correctedEmail),
      possiblyInvalid: false,
      validationResult: 'domain_typo',
      domain,
      debug: baseDebug({
        action: 'SuggestCorrection',
        customerEmail: normalized,
        confirmationRequired: true,
        error: 'domain_typo',
        note: `Suggested domain correction ${typo.fromDomain} → ${typo.toDomain}.`,
      }),
    });
  }

  if (isPossiblyInvalidEmailDomain(domain)) {
    return rejectGate({
      rawEmail: input.rawEmail,
      normalizedEmail: normalized,
      agentMessage: EMAIL_POSSIBLY_INVALID_PROMPT,
      possiblyInvalid: true,
      validationResult: 'invalid_domain_structure',
      domain,
      debug: baseDebug({
        action: 'AskForEmail',
        customerEmail: normalized,
        confirmationRequired: true,
        error: 'invalid_domain',
        note: `Domain "${domain}" failed structural validation.`,
      }),
    });
  }

  const sessionEmail = input.sessionConfirmedEmail?.trim().toLowerCase();
  const sessionConfirmed = input.sessionConfirmationState === 'confirmed';
  const toolConfirmed = coerceBoolean(input.emailConfirmed) === true;
  const emailMatchesSession = sessionEmail ? sessionEmail === normalized : false;

  if (!toolConfirmed && !(sessionConfirmed && emailMatchesSession)) {
    // Force strict boolean so PaymentEmailGateResult.possiblyInvalid never receives string/undefined.
    const sessionMismatch = Boolean(sessionConfirmed && sessionEmail && !emailMatchesSession);
    return rejectGate({
      rawEmail: input.rawEmail,
      normalizedEmail: normalized,
      agentMessage: sessionMismatch
        ? EMAIL_POSSIBLY_INVALID_PROMPT
        : EMAIL_CONFIRMATION_REQUIRED_PROMPT,
      possiblyInvalid: Boolean(sessionMismatch),
      validationResult: sessionMismatch ? 'email_session_mismatch' : 'email_not_confirmed',
      domain,
      debug: baseDebug({
        action: 'AskForEmail',
        customerEmail: normalized,
        confirmationRequired: true,
        error: sessionMismatch ? 'email_session_mismatch' : 'email_not_confirmed',
        note: sessionMismatch
          ? 'Session confirmed a different email than the tool payload.'
          : 'Customer must confirm email before SendPaymentLink (emailConfirmed: true).',
      }),
    });
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
