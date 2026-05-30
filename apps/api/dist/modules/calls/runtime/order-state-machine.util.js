"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeOrderState = normalizeOrderState;
exports.canAdvanceOrderState = canAdvanceOrderState;
exports.nextOrderState = nextOrderState;
const ORDER_FLOW = [
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
const LEGACY_STATE_MAP = {
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
function normalizeOrderState(value) {
    if (typeof value !== 'string')
        return 'IDLE';
    const v = value.trim();
    if (LEGACY_STATE_MAP[v])
        return LEGACY_STATE_MAP[v];
    return (ORDER_FLOW.find((s) => s === v) ?? 'IDLE');
}
function canAdvanceOrderState(from, to) {
    const fromIdx = ORDER_FLOW.indexOf(normalizeOrderState(from));
    const toIdx = ORDER_FLOW.indexOf(normalizeOrderState(to));
    if (fromIdx < 0 || toIdx < 0)
        return false;
    if (toIdx === fromIdx)
        return true;
    if (toIdx >= fromIdx)
        return true;
    if (normalizeOrderState(to) === 'PRODUCT_SEARCH' && fromIdx > ORDER_FLOW.indexOf('IDLE'))
        return true;
    if (normalizeOrderState(to) === 'IDLE')
        return true;
    return false;
}
function nextOrderState(current) {
    const idx = ORDER_FLOW.indexOf(normalizeOrderState(current));
    if (idx < 0 || idx >= ORDER_FLOW.length - 1)
        return current;
    return ORDER_FLOW[idx + 1];
}
//# sourceMappingURL=order-state-machine.util.js.map