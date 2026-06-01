/**
 * Transactional payment-email subject resolution (inbox-friendly defaults).
 * Used by PaymentEmailSubjectService and payment-email-templates.
 */

export const DEFAULT_PAYMENT_EMAIL_SUBJECT = 'Your SureShot Books Payment Link';

export const DEFAULT_PAYMENT_EMAIL_SUBJECT_TEMPLATE = 'Your {{storeName}} payment link';

export type PaymentEmailSubjectSource = 'env' | 'agent_template' | 'default';

export type ResolvedPaymentEmailSubject = {
  subject: string;
  source: PaymentEmailSubjectSource;
  overrideUsed: boolean;
};

const SPAM_PHRASE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/complete your secure checkout/gi, 'payment link'],
  [/secure checkout/gi, 'payment link'],
  [/\bsecure payment\b/gi, 'payment'],
];

const LEGAL_SUFFIX_RE = /\s*,?\s*(LLC|L\.L\.C\.|Inc\.?|Incorporated|Corp\.?|Corporation|Ltd\.?|Limited)\s*\.?$/i;

const MAX_SUBJECT_LENGTH = 78;

export function normalizeStoreNameForSubject(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return 'SureShot Books';
  const withoutLegal = trimmed.replace(LEGAL_SUFFIX_RE, '').trim();
  return withoutLegal || 'SureShot Books';
}

export function applyPaymentSubjectTemplate(template: string, storeName: string): string {
  const normalizedName = normalizeStoreNameForSubject(storeName);
  return template.replace(/\{\{storeName\}\}/gi, normalizedName);
}

/** Strip marketing/spam triggers and cap length for major mailbox providers. */
export function sanitizePaymentEmailSubject(raw: string): string {
  let subject = raw.trim().replace(/\s+/g, ' ');
  if (!subject) return DEFAULT_PAYMENT_EMAIL_SUBJECT;

  for (const [pattern, replacement] of SPAM_PHRASE_REPLACEMENTS) {
    subject = subject.replace(pattern, replacement);
  }

  subject = subject.replace(LEGAL_SUFFIX_RE, '').replace(/\s+/g, ' ').trim();

  subject = subject.replace(/[!?]{2,}/g, (m) => m[0] ?? '');
  subject = subject.replace(/\s*[-–—|]\s*$/g, '').trim();

  if (subject.length > MAX_SUBJECT_LENGTH) {
    subject = subject.slice(0, MAX_SUBJECT_LENGTH).trim();
  }

  return subject || DEFAULT_PAYMENT_EMAIL_SUBJECT;
}

export function resolvePaymentEmailSubject(input: {
  businessName?: string | null;
  subjectTemplate?: string | null;
  envOverride?: string | null;
}): ResolvedPaymentEmailSubject {
  const env = input.envOverride?.trim();
  if (env) {
    return {
      subject: sanitizePaymentEmailSubject(env),
      source: 'env',
      overrideUsed: true,
    };
  }

  const template = input.subjectTemplate?.trim();
  if (template) {
    const name = normalizeStoreNameForSubject(input.businessName);
    const subject = sanitizePaymentEmailSubject(applyPaymentSubjectTemplate(template, name));
    return { subject, source: 'agent_template', overrideUsed: false };
  }

  return {
    subject: DEFAULT_PAYMENT_EMAIL_SUBJECT,
    source: 'default',
    overrideUsed: false,
  };
}
