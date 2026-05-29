/**
 * Canonical voice checkout states — single source of truth for enterprise + transactional FSMs.
 */

/** All valid checkout state string literals (canonical + legacy transactional aliases). */
export const VOICE_CHECKOUT_STATES = [
  'IDLE',
  'LANGUAGE_DETECTED',
  'PRODUCT_SELECTED',
  'QUANTITY_REQUIRED',
  'QUANTITY_CONFIRMED',
  'EMAIL_REQUESTED',
  'EMAIL_COLLECTION_REQUIRED',
  'EMAIL_CAPTURED',
  'EMAIL_VALIDATING',
  'EMAIL_INVALID_RETRY',
  'EMAIL_CONFIRMATION_REQUIRED',
  'EMAIL_CONFIRMED',
  'PAYMENT_LINK_CREATING',
  'PAYMENT_EMAIL_SENDING',
  'PAYMENT_EMAIL_VERIFIED',
  'CHECKOUT_COMPLETED',
  'FALLBACK_DELIVERY_REQUIRED',
  /** @deprecated Use IDLE — retained for transactional resolver compatibility */
  'INACTIVE',
  /** @deprecated Use PRODUCT_SELECTED */
  'PRODUCT_CONFIRMED',
  /** @deprecated Use QUANTITY_REQUIRED */
  'QUANTITY_COLLECTION_REQUIRED',
  /** @deprecated Use EMAIL_VALIDATING */
  'EMAIL_VALIDATED',
  /** @deprecated Use CHECKOUT_COMPLETED or PAYMENT_EMAIL_VERIFIED */
  'PAYMENT_LINK_SENT',
] as const;

export type VoiceCheckoutState = (typeof VOICE_CHECKOUT_STATES)[number];

/** Enterprise + transactional FSMs share the same state union. */
export type EnterpriseCheckoutState = VoiceCheckoutState;
export type TransactionalCheckoutState = VoiceCheckoutState;

/** Named constants — prefer these over raw strings in new code. */
export const CheckoutState = {
  IDLE: 'IDLE',
  LANGUAGE_DETECTED: 'LANGUAGE_DETECTED',
  PRODUCT_SELECTED: 'PRODUCT_SELECTED',
  QUANTITY_REQUIRED: 'QUANTITY_REQUIRED',
  QUANTITY_CONFIRMED: 'QUANTITY_CONFIRMED',
  EMAIL_REQUESTED: 'EMAIL_REQUESTED',
  EMAIL_COLLECTION_REQUIRED: 'EMAIL_COLLECTION_REQUIRED',
  EMAIL_CAPTURED: 'EMAIL_CAPTURED',
  EMAIL_VALIDATING: 'EMAIL_VALIDATING',
  EMAIL_INVALID_RETRY: 'EMAIL_INVALID_RETRY',
  EMAIL_CONFIRMATION_REQUIRED: 'EMAIL_CONFIRMATION_REQUIRED',
  EMAIL_CONFIRMED: 'EMAIL_CONFIRMED',
  PAYMENT_LINK_CREATING: 'PAYMENT_LINK_CREATING',
  PAYMENT_EMAIL_SENDING: 'PAYMENT_EMAIL_SENDING',
  PAYMENT_EMAIL_VERIFIED: 'PAYMENT_EMAIL_VERIFIED',
  CHECKOUT_COMPLETED: 'CHECKOUT_COMPLETED',
  FALLBACK_DELIVERY_REQUIRED: 'FALLBACK_DELIVERY_REQUIRED',
  INACTIVE: 'INACTIVE',
  PRODUCT_CONFIRMED: 'PRODUCT_CONFIRMED',
  QUANTITY_COLLECTION_REQUIRED: 'QUANTITY_COLLECTION_REQUIRED',
  EMAIL_VALIDATED: 'EMAIL_VALIDATED',
  PAYMENT_LINK_SENT: 'PAYMENT_LINK_SENT',
} as const satisfies Record<string, VoiceCheckoutState>;

const CHECKOUT_STATE_SET = new Set<string>(VOICE_CHECKOUT_STATES);

/** Runtime guard for persisted / external state strings. */
export function isVoiceCheckoutState(value: unknown): value is VoiceCheckoutState {
  return typeof value === 'string' && CHECKOUT_STATE_SET.has(value);
}

/** Throws when a state literal is not in the canonical union (tests + defensive checks). */
export function assertValidCheckoutState(
  state: unknown,
  label = 'checkout state',
): asserts state is VoiceCheckoutState {
  if (!isVoiceCheckoutState(state)) {
    throw new Error(`Invalid ${label}: ${String(state)}`);
  }
}

export function isCheckoutInactive(state: VoiceCheckoutState): boolean {
  return state === CheckoutState.IDLE || state === CheckoutState.INACTIVE;
}

export function isTransactionalCheckoutActive(state: VoiceCheckoutState): boolean {
  return !isCheckoutInactive(state);
}
