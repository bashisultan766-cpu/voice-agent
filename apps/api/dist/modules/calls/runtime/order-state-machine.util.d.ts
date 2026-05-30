export type OrderState = 'IDLE' | 'PRODUCT_SEARCH' | 'PRODUCT_CONFIRMED' | 'QUANTITY_COLLECTED' | 'EMAIL_COLLECTING' | 'EMAIL_CONFIRMING' | 'PAYMENT_LINK_CREATING' | 'PAYMENT_LINK_SENT' | 'DONE' | 'PRODUCT_DISCOVERY' | 'EMAIL_COLLECTION' | 'PAYMENT_COLLECTION';
export declare function normalizeOrderState(value: unknown): OrderState;
export declare function canAdvanceOrderState(from: OrderState, to: OrderState): boolean;
export declare function nextOrderState(current: OrderState): OrderState;
