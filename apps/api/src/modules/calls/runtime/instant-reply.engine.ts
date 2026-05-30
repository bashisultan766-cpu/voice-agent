/**
 * Instant response engine — deterministic bypass of OpenAI, Shopify, DB, and TTS generation
 * for lightweight conversational turns and transactional checkout prompts.
 */
import type { TransactionalCheckoutState } from './checkout-state.types';
import { isPostPaymentClosingUtterance } from './voice-email-capture.util';
import { shouldBypassOpenAiGeneration } from './transactional-checkout-state.util';
import {
  buildInstantReply,
  classifyInstantReplyKind,
  instantReplyAudioPhrase,
  shouldUseInstantReply,
  shortenVoiceReply,
  VOICE_WORD_LIMITS,
  type InstantReplyKind,
} from './instant-reply.util';

export type OpenAiBypassReason =
  | 'instant_deterministic_reply'
  | 'instant_deterministic_sync'
  | 'transactional_checkout_state'
  | 'checkout_lock_active'
  | 'post_payment_closing'
  | 'email_prompt_deterministic'
  | 'confirmation_prompt_deterministic'
  | 'language_switch_deterministic'
  | 'repeat_request'
  | 'goodbye_deterministic'
  | null;

export type ShouldBypassOpenAiInput = {
  text: string;
  orderState?: string;
  transactionalCheckoutState?: TransactionalCheckoutState | null;
  checkoutLockActive?: boolean;
  spellingCaptureActive?: boolean;
  /** When true, caller explicitly asked to switch language. */
  explicitLanguageSwitch?: boolean;
};

export type ShouldBypassOpenAiResult = {
  bypass: boolean;
  openaiSkippedReason: OpenAiBypassReason;
  instantKind?: InstantReplyKind | null;
};

/** Central gate: OpenAI MUST NOT run for greetings, checkout, thank-you, repeat, language switch, etc. */
export function shouldBypassOpenAI(input: ShouldBypassOpenAiInput): ShouldBypassOpenAiResult {
  const text = input.text.trim();
  const orderState = (input.orderState ?? 'IDLE').trim() || 'IDLE';

  if (!text) {
    return { bypass: false, openaiSkippedReason: null };
  }

  if (input.spellingCaptureActive) {
    return { bypass: false, openaiSkippedReason: null };
  }

  if (isPostPaymentClosingUtterance(text)) {
    return { bypass: true, openaiSkippedReason: 'post_payment_closing' };
  }

  const instantKind = classifyInstantReplyKind(text);
  if (instantKind === 'repeat') {
    return { bypass: true, openaiSkippedReason: 'repeat_request', instantKind };
  }

  if (input.explicitLanguageSwitch) {
    return { bypass: true, openaiSkippedReason: 'language_switch_deterministic', instantKind };
  }

  if (shouldUseInstantReply(text, orderState)) {
    return { bypass: true, openaiSkippedReason: 'instant_deterministic_reply', instantKind };
  }

  const checkoutState = input.transactionalCheckoutState ?? null;
  if (checkoutState && shouldBypassOpenAiGeneration(checkoutState)) {
    return { bypass: true, openaiSkippedReason: 'transactional_checkout_state' };
  }

  if (input.checkoutLockActive) {
    return { bypass: true, openaiSkippedReason: 'checkout_lock_active' };
  }

  return { bypass: false, openaiSkippedReason: null, instantKind };
}

/** Build deterministic reply text for instant bypass turns. */
export function buildInstantEngineReply(text: string, storeName = 'SureShot Books'): string {
  return shortenVoiceReply(buildInstantReply(text, storeName), VOICE_WORD_LIMITS.simple);
}

/** Exact phrase text for pre-cached ElevenLabs audio (hot path). */
export function resolveInstantAudioPhrase(text: string, storeName = 'SureShot Books'): string {
  return instantReplyAudioPhrase(text, storeName);
}

export {
  buildInstantReply,
  classifyInstantReplyKind,
  instantReplyAudioPhrase,
  shouldUseInstantReply,
  shortenVoiceReply,
  VOICE_WORD_LIMITS,
};
