/**
 * Production voice email capture — normalization, validation, prompts, logging, and retry policy.
 */
import {
  validateEnterpriseEmailSync,
  type EnterpriseEmailValidation,
} from './voice-email-enterprise-validation.util';

/** Production-grade email validation (RFC 5322 simplified, practical for voice capture). */
export const VOICE_EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export const MAX_VOICE_EMAIL_RETRIES = 3;
export const MAX_EMAIL_SEND_RETRIES = 2;

export const CHECKOUT_PRODUCT_CONFIRMED_PROMPT =
  "Perfect. I'll help you place the order.";

/** @deprecated Use CHECKOUT_PRODUCT_CONFIRMED_PROMPT */
export const PRODUCT_CONFIRMATION_PROMPT = CHECKOUT_PRODUCT_CONFIRMED_PROMPT;

export const PRODUCT_CHECKOUT_INTRODUCED_KEY = 'productCheckoutIntroduced';

export const EMAIL_DISPOSABLE_REJECT_PROMPT =
  'That email domain cannot receive payment links. Please provide a personal email address you check regularly, spelled slowly.';

export const EMAIL_MX_REJECT_PROMPT =
  'I could not verify that email domain. Please spell your email address again slowly, character by character.';

export type PaymentEmailDeliveryResult = {
  success: boolean;
  smtpAccepted: boolean;
  providerSuccess: boolean;
  deliveryQueued: boolean;
  providerMessageId?: string | null;
  deduplicated?: boolean;
  errorCode?: string;
};

/** First-time email collection only — no long spoken example on retries. */
export const EMAIL_SPELL_COLLECTION_PROMPT =
  'Please spell your email address slowly, letter by letter, so I can send your payment link correctly.';

export const EMAIL_SPELL_COLLECTION_PROMPT_ALT =
  'Please say your email slowly, letter by letter.';

/** Premium opener before spell-slowly email collection. */
export const EMAIL_COLLECTION_WITH_CONTEXT_PROMPT = `${CHECKOUT_PRODUCT_CONFIRMED_PROMPT} ${EMAIL_SPELL_COLLECTION_PROMPT}`;

export const EMAIL_INVALID_VERIFY_RETRY_PROMPT =
  "I couldn't verify that email. Please spell your email address again, letter by letter.";

export const EMAIL_INVALID_CAPTURE_RETRY_PROMPT =
  'I may have captured that incorrectly. Please spell your email again, letter by letter.';

/** @deprecated Use EMAIL_INVALID_CAPTURE_RETRY_PROMPT */
export const EMAIL_INVALID_CAPTURE_PROMPT = EMAIL_INVALID_CAPTURE_RETRY_PROMPT;

export const POST_PAYMENT_THANK_YOU_REPLY =
  "You're welcome. Thank you for your order.";

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
  /Perfect\. I'll help you place the order/i,
  /Just to confirm, your email is/i,
  /spell your email address slowly/i,
  /letter by letter/i,
  /I couldn't verify that email/i,
  /I may have captured that incorrectly/i,
  /You're welcome\. Thank you for your order/i,
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
  enterprise?: EnterpriseEmailValidation;
};

export type VoiceEmailCaptureLogEvent =
  | 'voice.email.captured'
  | 'voice.email.validated'
  | 'voice.email.confirmed'
  | 'voice.email.rejected'
  | 'voice.email.send_status'
  | 'voice.email.send_error'
  | 'voice.email.delivery_confirmed'
  | 'voice.email.fallback_offered'
  | 'voice.email.typo_suggested';

/** Structured checkout journey events (grep-friendly, no auto-checkout semantics). */
export type CheckoutJourneyLogEvent =
  | 'email_collection_prompt_sent'
  | 'email_captured'
  | 'email_validation_passed'
  | 'email_confirmation_required'
  | 'customer_confirmed_email'
  | 'payment_link_created'
  | 'payment_email_delivery_confirmed';

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
  smtpAccepted?: boolean;
  providerSuccess?: boolean;
  deliveryQueued?: boolean;
  fallbackOffered?: boolean;
  fallbackChannel?: string | null;
  retryAttempt?: number;
  validationFailureReason?: string;
  typoCorrected?: boolean;
  mxValid?: boolean | null;
  disposable?: boolean;
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
  const enterprise = validateEnterpriseEmailSync(raw);
  return {
    valid: enterprise.valid,
    normalized: enterprise.normalized,
    raw: raw.trim(),
    enterprise,
  };
}

export function buildProductConfirmationPrompt(): string {
  return CHECKOUT_PRODUCT_CONFIRMED_PROMPT;
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

/** Spoken form for TTS — avoids pauses on @ and bare dots in ElevenLabs playback. */
export function formatEmailForVoiceConfirmation(email: string): string {
  const t = email.trim().toLowerCase();
  const at = t.indexOf('@');
  if (at < 1) return email.trim();
  const local = t.slice(0, at).replace(/\./g, ' dot ');
  const domain = t.slice(at + 1).replace(/\./g, ' dot ');
  return `${local} at ${domain}`;
}

export function buildEmailConfirmationPrompt(email: string): string {
  const spoken = formatEmailForVoiceConfirmation(email);
  return `Just to confirm, your email is ${spoken}. Is that correct?`;
}

/** After payment link sent — polite close; do not restart email collection. */
export function isPostPaymentClosingUtterance(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t) return false;
  if (extractEmailFromSpeech(text)) return false;
  if (/\b(email|checkout|order another|another book|payment link)\b/.test(t)) return false;
  return /\b(thank you|thanks|thankyou|ok|okay|alright|got it|appreciate it|perfect|great)\b/.test(t);
}

export function buildCheckoutProductConfirmedPrompt(): string {
  return CHECKOUT_PRODUCT_CONFIRMED_PROMPT;
}

export function buildEmailCollectionPrompt(retryCount = 0, withOrderContext = false): string {
  if (retryCount >= MAX_VOICE_EMAIL_RETRIES) {
    return EMAIL_SPELL_COLLECTION_PROMPT_ALT;
  }
  if (retryCount > 0) {
    return EMAIL_INVALID_VERIFY_RETRY_PROMPT;
  }
  return withOrderContext ? EMAIL_COLLECTION_WITH_CONTEXT_PROMPT : EMAIL_SPELL_COLLECTION_PROMPT;
}

export function buildTypoCorrectionPrompt(correctedEmail: string, originalEmail: string): string {
  return `Just to double-check, did you mean ${correctedEmail}? I heard ${originalEmail}.`;
}

export function buildDisposableEmailRejectPrompt(): string {
  return EMAIL_DISPOSABLE_REJECT_PROMPT;
}

export function buildMxRejectPrompt(): string {
  return EMAIL_MX_REJECT_PROMPT;
}

export function isFallbackChannelAffirmative(text: string): 'whatsapp' | 'sms' | null {
  const t = text.toLowerCase().trim();
  if (!t || /\b(no|not|email instead)\b/.test(t)) return null;
  if (/\b(whatsapp|whats app|what'?s app)\b/.test(t)) return 'whatsapp';
  if (/\b(sms|text message|text me|text it)\b/.test(t)) return 'sms';
  if (/\b(yes|yeah|sure|please|ok|okay)\b/.test(t)) {
    if (/\bwhatsapp\b/.test(t)) return 'whatsapp';
    if (/\b(sms|text)\b/.test(t)) return 'sms';
  }
  return null;
}

export function buildInvalidEmailRetryPrompt(retryCount: number): string {
  if (!shouldOfferEmailRetry(retryCount)) {
    return EMAIL_SPELL_COLLECTION_PROMPT_ALT;
  }
  return EMAIL_INVALID_VERIFY_RETRY_PROMPT;
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
  /** Utterance with a new email is capture/correction, not a simple yes. */
  if (extractEmailFromSpeech(text)) return false;
  if (/\b(no|not|wrong|incorrect|change|different|nope|nah)\b/.test(t)) return false;
  if (/\b(that'?s|yes).{0,24}my email\b/.test(t)) return true;
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

export function buildCheckoutJourneyLog(
  event: CheckoutJourneyLogEvent,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return { event, ...fields };
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
    ...(input.smtpAccepted != null ? { smtpAccepted: input.smtpAccepted } : {}),
    ...(input.providerSuccess != null ? { providerSuccess: input.providerSuccess } : {}),
    ...(input.deliveryQueued != null ? { deliveryQueued: input.deliveryQueued } : {}),
    ...(input.fallbackOffered != null ? { fallbackOffered: input.fallbackOffered } : {}),
    ...(input.fallbackChannel != null ? { fallbackChannel: input.fallbackChannel } : {}),
    ...(input.retryAttempt != null ? { retryAttempt: input.retryAttempt } : {}),
    ...(input.validationFailureReason
      ? { validationFailureReason: input.validationFailureReason }
      : {}),
    ...(input.typoCorrected != null ? { typoCorrected: input.typoCorrected } : {}),
    ...(input.mxValid !== undefined ? { mxValid: input.mxValid } : {}),
    ...(input.disposable != null ? { disposable: input.disposable } : {}),
  };
}

/** Parse sendPaymentEmail tool payload into a delivery gate for voice replies. */
export function parsePaymentEmailDeliveryFromToolData(
  data: Record<string, unknown> | null | undefined,
  toolOk: boolean,
): PaymentEmailDeliveryResult {
  const deduplicated = data?.deduplicated === true;
  const api = data?.emailApiResult;
  if (api && typeof api === 'object' && !Array.isArray(api)) {
    const row = api as Record<string, unknown>;
    const success = row.success === true && toolOk;
    return {
      success,
      smtpAccepted: row.smtpAccepted === true,
      providerSuccess: row.providerSuccess === true,
      deliveryQueued: row.deliveryQueued === true,
      providerMessageId:
        typeof row.providerMessageId === 'string' ? row.providerMessageId : null,
      deduplicated,
    };
  }

  const deliveryConfirmed = data?.deliveryConfirmed === true;
  const providerMessageId =
    typeof data?.providerMessageId === 'string' ? data.providerMessageId : null;
  const success = toolOk && deliveryConfirmed;
  return {
    success,
    smtpAccepted: success,
    providerSuccess: success,
    deliveryQueued: success && !deduplicated,
    providerMessageId,
    deduplicated,
  };
}

/** Only true when provider accepted the message — never claim success without this. */
export function isPaymentEmailDeliveryConfirmed(
  delivery: PaymentEmailDeliveryResult | null | undefined,
): boolean {
  if (!delivery) return false;
  return (
    delivery.success === true &&
    delivery.providerSuccess === true &&
    (delivery.smtpAccepted === true || delivery.deliveryQueued === true)
  );
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
  if (deliveryConfirmed) {
    if (containsPaymentSuccessClaim(text) && /@/.test(text)) {
      return buildPaymentEmailSuccessPrompt();
    }
    return text.trim();
  }
  if (!containsPaymentSuccessClaim(text)) return text.trim();
  return buildPaymentEmailSendFailurePrompt();
}
