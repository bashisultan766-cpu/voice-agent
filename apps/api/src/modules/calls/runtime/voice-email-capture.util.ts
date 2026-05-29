/**
 * Robust voice email capture — normalization, validation, prompts, and structured logging.
 */

export const VOICE_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MAX_VOICE_EMAIL_RETRIES = 3;

export const EMAIL_SPELL_COLLECTION_PROMPT =
  'Please spell your email address slowly using alphabets.';

export const PAYMENT_EMAIL_SEND_FAILURE_PROMPT =
  'I apologize, there was an issue sending the payment link. Let me try again.';

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
  sendOk?: boolean;
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
    return 'I want to make sure I have this right. Please spell your email one more time, letter by letter.';
  }
  if (retryCount > 0) {
    return 'I apologize—I did not quite catch that. Please spell your email address slowly using alphabets.';
  }
  return EMAIL_SPELL_COLLECTION_PROMPT;
}

export function buildInvalidEmailRetryPrompt(retryCount: number): string {
  if (retryCount >= MAX_VOICE_EMAIL_RETRIES) {
    return 'That still does not look like a complete email address. Please spell it one final time, letter by letter.';
  }
  return buildEmailCollectionPrompt(retryCount);
}

export function buildPaymentEmailSendFailurePrompt(): string {
  return PAYMENT_EMAIL_SEND_FAILURE_PROMPT;
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
    ...(input.sendOk != null ? { sendOk: input.sendOk } : {}),
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
