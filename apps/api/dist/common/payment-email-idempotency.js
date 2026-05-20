"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.paymentEmailIdempotencyKey = paymentEmailIdempotencyKey;
const crypto_1 = require("crypto");
function paymentEmailIdempotencyKey(parts) {
    const email = parts.recipientEmail.trim().toLowerCase();
    const base = [
        parts.tenantId,
        parts.agentId,
        parts.checkoutLinkId,
        email,
        parts.purpose ?? 'payment_link',
    ].join('|');
    return (0, crypto_1.createHash)('sha256').update(base, 'utf8').digest('hex');
}
//# sourceMappingURL=payment-email-idempotency.js.map