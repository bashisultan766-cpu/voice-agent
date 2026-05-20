/** Simplified bookstore voice flow: discover product → email → done. */
export type OrderState = 'IDLE' | 'PRODUCT_DISCOVERY' | 'EMAIL_COLLECTION' | 'DONE';

const ORDER_FLOW: OrderState[] = ['IDLE', 'PRODUCT_DISCOVERY', 'EMAIL_COLLECTION', 'DONE'];

/** Map legacy session metadata to the simplified model. */
const LEGACY_STATE_MAP: Record<string, OrderState> = {
  IDLE: 'IDLE',
  PRODUCT_DISCOVERY: 'PRODUCT_DISCOVERY',
  PRODUCT_CONFIRMATION: 'PRODUCT_DISCOVERY',
  VARIANT_SELECTION: 'PRODUCT_DISCOVERY',
  QUANTITY: 'PRODUCT_DISCOVERY',
  CUSTOMER_NAME: 'EMAIL_COLLECTION',
  EMAIL_COLLECTION: 'EMAIL_COLLECTION',
  ORDER_CONFIRMATION: 'EMAIL_COLLECTION',
  PAYMENT_LINK_GENERATION: 'EMAIL_COLLECTION',
  EMAIL_SENT: 'DONE',
  END: 'DONE',
  DONE: 'DONE',
};

export function normalizeOrderState(value: unknown): OrderState {
  if (typeof value !== 'string') return 'IDLE';
  const v = value.trim();
  if (LEGACY_STATE_MAP[v]) return LEGACY_STATE_MAP[v];
  return (ORDER_FLOW.find((s) => s === v) ?? 'IDLE') as OrderState;
}

/**
 * Allow forward progress, stepping back to product discovery for a new title,
 * or reset to IDLE.
 */
export function canAdvanceOrderState(from: OrderState, to: OrderState): boolean {
  const fromIdx = ORDER_FLOW.indexOf(from);
  const toIdx = ORDER_FLOW.indexOf(to);
  if (fromIdx < 0 || toIdx < 0) return false;
  if (to === from) return true;
  if (toIdx >= fromIdx) return true;
  if (to === 'PRODUCT_DISCOVERY' && fromIdx > ORDER_FLOW.indexOf('IDLE')) return true;
  if (to === 'IDLE') return true;
  return false;
}

export function nextOrderState(current: OrderState): OrderState {
  const idx = ORDER_FLOW.indexOf(current);
  if (idx < 0 || idx >= ORDER_FLOW.length - 1) return current;
  return ORDER_FLOW[idx + 1];
}
