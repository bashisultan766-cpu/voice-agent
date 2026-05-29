/**
 * Production voice email capture — normalization, validation, prompts, logging, and retry policy.
 */

/** Production-grade email validation (RFC 5322 simplified, practical for voice capture). */
export const VOICE_EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export const MAX_VOICE_EMAIL_RETRIES = 3;
export const MAX_EMAIL_SEND_RETRIES = 2;

export const EMAIL_SPELL_COLLECTION_PROMPT =
  'Perfect. Please spell your email address slowly using alphabets so I can send your payment link correctly.';

export const EMAIL_SPELL_COLLECTION_PROMPT_ALT =
  'Please say your email slowly, character by character.';

export const EMAIL_INVALID_CAPTURE_PROMPT =
  'I may have captured that incorrectly. Could you please repeat your email slowly?';

export const EMAIL_PROCESSING_PROMPT = 'Perfect. Processing your order now.';

export const PAYMENT_EMAIL_SUCCESS_PROMPT =
  'Your payment link has been sent successfully. Please check your inbox.';

export const PAYMENT_EMAIL_SEND_FAILURE_PROMPT =
  'I apologize, there was an issue sending the payment link. Let me try again.';

export const PAYMENT_EMAIL_FALLBACK_DELIVERY_PROMPT =
  'I apologize — I was unable to send the payment link by email after a couple of attempts. Would you prefer I send it via WhatsApp or SMS instead?';

const PAYMENT_SUCCESS_CLAIM_PATTERNS: RegExp[] = [
  /\bpayment link (has been )?sent\b/i,
  /\bsent (the )?(secure )?payment link\b/i,
  /\bcheck your inbox\b/i,
  /\byou(?:'ll| will) receive the payment link\b/i,
  /\bemail(?:ed)? (you )?the (checkout|payment) link\b/i,
];

const DETERMINISTIC_TRANSACTIONAL_MARKERS: RegExp[] = [
  /Just to confirm, your email is/i,
  /spell your email address slowly/i,
  /say your email slowly, character by character/i,
  /I may have captured that incorrectly/i,
  /Perfect\. Processing your order now/i,
  /Your payment link has been sent successfully/i,
  /there was an issue sending the payment link/i,
  /unable to send the payment link by email/i,
  /WhatsApp or SMS/i,
];

const NUMBER_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

export type VoiceEmailValidationResult = {
  valid: boolean;
  normalized: string;
  raw: string;
};

export type VoiceEmailCaptureLogEvent =
  | 'voice.email.captured'
  | 'voice.email.validated'
  | 'voice.email.confirmed'
  | 'voice.email.rejected'
  | 'voice.email.send_status'
  | 'voice.email.send_error';

export type VoiceEmailCaptureLogInput = {
  event: VoiceEmailCaptureLogEvent;
  callSessionId?: string;
  tenantId?: string;
  agentId?: string;
  rawPreview?: string;
  normalizedPreview?: string;
  maskedEmail?: string;
  valid?: boolean;
  retryCount?: number;
  confirmationStatus?: 'pending' | 'confirmed' | 'rejected';
  sendOk?: boolean;
  sendFailureCount?: number;
  errorCode?: string;
  errorMessage?: string;
};

/** Convert spoken email fragments: "at" → "@", "dot" → ".", collapse spaces, digit words → digits. */
export function normalizeSpokenEmail(email: string): string {
  const cleaned = email.trim().toLowerCase();
  if (!cleaned) return cleaned;

  let normalized = cleaned
    .replace(/\bat the rate\b/g, '@')
    .replace(/\bat sign\b/g, '@')
    .replace(/\bat\b/g, '@')
    .replace(/\bdot\b/g, '.');

  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    normalized = normalized.replace(new RegExp(`\\b${word}\\b`, 'g'), digit);
  }

  normalized = normalized.replace(/\s+/g, '');
  return normalized;
}

export function validateVoiceEmail(raw: string): VoiceEmailValidationResult {
  const normalized = normalizeSpokenEmail(raw);
  return {
    valid: VOICE_EMAIL_REGEX.test(normalized),
    normalized,
    raw: raw.trim(),
  };
}

/** Extract email from direct spelling or spoken "at"/"dot" patterns. */
export function extractEmailFromSpeech(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const direct = trimmed.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (direct) return direct[0];

  const spokenCue =
    /\b(at the rate|at sign|at|dot)\b/i.test(trimmed) || trimmed.includes('@');
  if (!spokenCue) return null;

  const normalized = normalizeSpokenEmail(trimmed);
  if (normalized.includes('@')) return normalized;
  return null;
}

export function buildEmailConfirmationPrompt(email: string): string {
  const safe = email.trim();
  return `Just to confirm, your email is ${safe}. Is that correct?`;
}

export function buildEmailCollectionPrompt(retryCount = 0): string {
  if (retryCount >= MAX_VOICE_EMAIL_RETRIES) {
    return `${EMAIL_SPELL_COLLECTION_PROMPT_ALT} I want to make sure I have this right.`;
  }
  if (retryCount > 0) {
    return 'I apologize—I did not quite catch that. Please spell your email address slowly using alphabets.';
  }
  return EMAIL_SPELL_COLLECTION_PROMPT;
}

export function buildInvalidEmailRetryPrompt(retryCount: number): string {
  if (!shouldOfferEmailRetry(retryCount)) {
    return `${EMAIL_INVALID_CAPTURE_PROMPT} ${EMAIL_SPELL_COLLECTION_PROMPT_ALT}`;
  }
  return EMAIL_INVALID_CAPTURE_PROMPT;
}

export function buildEmailProcessingPrompt(): string {
  return EMAIL_PROCESSING_PROMPT;
}

export function buildPaymentEmailSuccessPrompt(): string {
  return PAYMENT_EMAIL_SUCCESS_PROMPT;
}

export function buildPaymentEmailSendFailurePrompt(failureCount = 1): string {
  if (failureCount >= MAX_EMAIL_SEND_RETRIES) {
    return PAYMENT_EMAIL_FALLBACK_DELIVERY_PROMPT;
  }
  return PAYMENT_EMAIL_SEND_FAILURE_PROMPT;
}

export function buildPaymentEmailFallbackDeliveryPrompt(): string {
  return PAYMENT_EMAIL_FALLBACK_DELIVERY_PROMPT;
}

export function isEmailConfirmationAffirmative(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t) return false;
  if (/\b(no|not|wrong|incorrect|change|different|nope|nah)\b/.test(t)) return false;
  return (
    /\b(yes|yeah|yep|correct|that'?s right|right|exactly|confirmed|confirm|perfect|absolutely|sure)\b/.test(
      t,
    ) || /^(ok|okay|si|sì|да|ок)\.?$/i.test(t)
  );
}

export function isEmailConfirmationNegative(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t) return false;
  return /\b(no|wrong|incorrect|not correct|not right|change|different|try again|nope|nah)\b/.test(t);
}

export function maskEmailForLog(email: string): string {
  const t = email.trim().toLowerCase();
  const at = t.indexOf('@');
  if (at < 1) return '***';
  return `${t[0]}***${t.slice(at)}`;
}

export function maskRawSpeechForLog(text: string): string {
  const extracted = extractEmailFromSpeech(text);
  if (!extracted) return text.slice(0, 80);
  return text.replace(extracted, maskEmailForLog(extracted)).slice(0, 80);
}

export function buildVoiceEmailCaptureLog(input: VoiceEmailCaptureLogInput): Record<string, unknown> {
  return {
    event: input.event,
    ...(input.callSessionId ? { callSessionId: input.callSessionId } : {}),
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.rawPreview != null ? { rawPreview: input.rawPreview.slice(0, 80) } : {}),
    ...(input.normalizedPreview != null
      ? { normalizedPreview: input.normalizedPreview.slice(0, 80) }
      : {}),
    ...(input.maskedEmail ? { maskedEmail: input.maskedEmail } : {}),
    ...(input.valid != null ? { valid: input.valid } : {}),
    ...(input.retryCount != null ? { retryCount: input.retryCount } : {}),
    ...(input.confirmationStatus ? { confirmationStatus: input.confirmationStatus } : {}),
    ...(input.sendOk != null ? { sendOk: input.sendOk } : {}),
    ...(input.sendFailureCount != null ? { sendFailureCount: input.sendFailureCount } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(input.errorMessage ? { errorMessage: input.errorMessage.slice(0, 300) } : {}),
  };
}

export function nextEmailRetryCount(current: number, valid: boolean): number {
  return valid ? current : current + 1;
}

export function shouldOfferEmailRetry(retryCount: number): boolean {
  return retryCount < MAX_VOICE_EMAIL_RETRIES;
}

/** True when reply is a deterministic transactional line that must not be LLM-rewritten. */
export function isDeterministicTransactionalReply(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return DETERMINISTIC_TRANSACTIONAL_MARKERS.some((re) => re.test(t));
}

/** Detect phrases that claim payment email was sent — must only appear after API success. */
export function containsPaymentSuccessClaim(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return PAYMENT_SUCCESS_CLAIM_PATTERNS.some((re) => re.test(t));
}

/** Strip hallucinated payment-success claims when delivery was not confirmed. */
export function sanitizePaymentSuccessClaim(text: string, deliveryConfirmed: boolean): string {
  if (deliveryConfirmed || !containsPaymentSuccessClaim(text)) return text.trim();
  return buildPaymentEmailSendFailurePrompt();
}
