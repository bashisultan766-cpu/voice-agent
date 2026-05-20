"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const checkout_email_policy_util_1 = require("./checkout-email-policy.util");
(0, node_test_1.default)('blocks checkout when askEmailBeforePaymentLink is enabled and email missing', () => {
    strict_1.default.equal((0, checkout_email_policy_util_1.isEmailRequiredBeforeCheckout)({
        askEmailBeforePaymentLink: true,
        customerEmail: null,
        destinationEmail: null,
    }), true);
});
(0, node_test_1.default)('allows checkout when email exists or policy disabled', () => {
    strict_1.default.equal((0, checkout_email_policy_util_1.isEmailRequiredBeforeCheckout)({
        askEmailBeforePaymentLink: true,
        customerEmail: 'customer@example.com',
    }), false);
    strict_1.default.equal((0, checkout_email_policy_util_1.isEmailRequiredBeforeCheckout)({
        askEmailBeforePaymentLink: false,
        customerEmail: null,
        destinationEmail: null,
    }), false);
});
//# sourceMappingURL=checkout-email-policy.util.test.js.map