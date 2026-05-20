export type OrderState = 'IDLE' | 'PRODUCT_DISCOVERY' | 'EMAIL_COLLECTION' | 'DONE';
export declare function normalizeOrderState(value: unknown): OrderState;
export declare function canAdvanceOrderState(from: OrderState, to: OrderState): boolean;
export declare function nextOrderState(current: OrderState): OrderState;
