/** Shore Shot checkout flow + backward-compatible legacy states. */
export type OrderState =
  | 'IDLE'
  | 'PRODUCT_SEARCH'
  | 'PRODUCT_CONFIRMED'
  | 'QUANTITY_COLLECTED'
  | 'EMAIL_COLLECTING'
  | 'EMAIL_CONFIRMING'
  | 'PAYMENT_LINK_CREATING'
  | 'PAYMENT_LINK_SENT'
  | 'DONE'
  // legacy compatibility:
  | 'PRODUCT_DISCOVERY'
  | 'EMAIL_COLLECTION'
  | 'PAYMENT_COLLECTION';

type CanonicalOrderState =
  | 'IDLE'
  | 'PRODUCT_SEARCH'
  | 'PRODUCT_CONFIRMED'
  | 'QUANTITY_COLLECTED'
  | 'EMAIL_COLLECTING'
  | 'EMAIL_CONFIRMING'
  | 'PAYMENT_LINK_CREATING'
  | 'PAYMENT_LINK_SENT'
  | 'DONE';

const ORDER_FLOW: CanonicalOrderState[] = [
  'IDLE',
  'PRODUCT_SEARCH',
  'PRODUCT_CONFIRMED',
  'QUANTITY_COLLECTED',
  'EMAIL_COLLECTING',
  'EMAIL_CONFIRMING',
  'PAYMENT_LINK_CREATING',
  'PAYMENT_LINK_SENT',
  'DONE',
];

/** Map legacy session metadata to the simplified model. */
const LEGACY_STATE_MAP: Record<string, CanonicalOrderState> = {
  IDLE: 'IDLE',
  PRODUCT_SEARCH: 'PRODUCT_SEARCH',
  PRODUCT_DISCOVERY: 'PRODUCT_SEARCH',
  PRODUCT_CONFIRMATION: 'PRODUCT_CONFIRMED',
  PRODUCT_CONFIRMED: 'PRODUCT_CONFIRMED',
  VARIANT_SELECTION: 'PRODUCT_CONFIRMED',
  QUANTITY: 'QUANTITY_COLLECTED',
  QUANTITY_COLLECTED: 'QUANTITY_COLLECTED',
  CUSTOMER_NAME: 'EMAIL_COLLECTING',
  EMAIL_COLLECTION: 'EMAIL_COLLECTING',
  EMAIL_COLLECTING: 'EMAIL_COLLECTING',
  EMAIL_CONFIRMING: 'EMAIL_CONFIRMING',
  ORDER_CONFIRMATION: 'PAYMENT_LINK_CREATING',
  PAYMENT_LINK_GENERATION: 'PAYMENT_LINK_CREATING',
  PAYMENT_COLLECTION: 'EMAIL_COLLECTING',
  PAYMENT_LINK_CREATING: 'PAYMENT_LINK_CREATING',
  PAYMENT_LINK_SENT: 'PAYMENT_LINK_SENT',
  EMAIL_SENT: 'PAYMENT_LINK_SENT',
  END: 'DONE',
  DONE: 'DONE',
};

export function normalizeOrderState(value: unknown): OrderState {
  if (typeof value !== 'string') return 'IDLE';
  const v = value.trim();
  if (LEGACY_STATE_MAP[v]) return LEGACY_STATE_MAP[v];
  return (ORDER_FLOW.find((s) => s === v) ?? 'IDLE') as CanonicalOrderState;
}

/**
 * Allow forward progress, stepping back to product discovery for a new title,
 * or reset to IDLE.
 */
export function canAdvanceOrderState(from: OrderState, to: OrderState): boolean {
  const fromIdx = ORDER_FLOW.indexOf(normalizeOrderState(from) as CanonicalOrderState);
  const toIdx = ORDER_FLOW.indexOf(normalizeOrderState(to) as CanonicalOrderState);
  if (fromIdx < 0 || toIdx < 0) return false;
  if (toIdx === fromIdx) return true;
  if (toIdx >= fromIdx) return true;
  if (normalizeOrderState(to) === 'PRODUCT_SEARCH' && fromIdx > ORDER_FLOW.indexOf('IDLE')) return true;
  if (normalizeOrderState(to) === 'IDLE') return true;
  return false;
}

export function nextOrderState(current: OrderState): OrderState {
  const idx = ORDER_FLOW.indexOf(normalizeOrderState(current) as CanonicalOrderState);
  if (idx < 0 || idx >= ORDER_FLOW.length - 1) return current;
  return ORDER_FLOW[idx + 1];
}
