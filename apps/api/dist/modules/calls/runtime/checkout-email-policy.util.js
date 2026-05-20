"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isEmailRequiredBeforeCheckout = isEmailRequiredBeforeCheckout;
function isEmailRequiredBeforeCheckout(params) {
    const askEmail = params.askEmailBeforePaymentLink !== false;
    if (!askEmail)
        return false;
    return !(params.customerEmail?.trim() || params.destinationEmail?.trim());
}
//# sourceMappingURL=checkout-email-policy.util.js.map