"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPaymentWebhookEventKey = buildPaymentWebhookEventKey;
exports.maskEmail = maskEmail;
exports.minimalWebhookPayload = minimalWebhookPayload;
function buildPaymentWebhookEventKey(topic, orderId, tenantId, checkoutLinkId) {
    return `${topic}:${orderId}:${tenantId}:${checkoutLinkId}`;
}
function maskEmail(email) {
    if (!email)
        return null;
    const at = email.indexOf('@');
    if (at <= 1)
        return '***';
    return `${email[0]}***${email.slice(at)}`;
}
function minimalWebhookPayload(topic, payload) {
    const email = payload.email || payload.contact_email || null;
    return {
        topic,
        orderId: payload.id != null ? String(payload.id) : null,
        orderName: payload.name ?? null,
        financialStatus: payload.financial_status ?? null,
        createdAt: payload.created_at ?? null,
        updatedAt: payload.updated_at ?? null,
        cancelledAt: payload.cancelled_at ?? null,
        closedAt: payload.closed_at ?? null,
        maskedCustomerEmail: maskEmail(email),
    };
}
//# sourceMappingURL=webhook-reconciliation.util.js.map