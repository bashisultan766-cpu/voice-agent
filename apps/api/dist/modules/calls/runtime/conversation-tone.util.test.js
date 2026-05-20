"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const conversation_tone_util_1 = require("./conversation-tone.util");
(0, node_test_1.default)('detectConversationTone: short utterance without ? is direct', () => {
    strict_1.default.equal((0, conversation_tone_util_1.detectConversationTone)('yes'), 'direct');
});
(0, node_test_1.default)('detectConversationTone: thanks is friendly', () => {
    strict_1.default.equal((0, conversation_tone_util_1.detectConversationTone)('thanks so much'), 'friendly');
});
(0, node_test_1.default)('computeAllowPaymentSuggestion: purchase_confirmation', () => {
    strict_1.default.equal((0, conversation_tone_util_1.computeAllowPaymentSuggestion)({
        userIntent: 'purchase_confirmation',
        clsIntent: 'product_search',
        orderState: 'PRODUCT_DISCOVERY',
    }), true);
});
(0, node_test_1.default)('computeAllowPaymentSuggestion: browsing product_search only', () => {
    strict_1.default.equal((0, conversation_tone_util_1.computeAllowPaymentSuggestion)({
        userIntent: 'product_search',
        clsIntent: 'product_search',
        orderState: 'PRODUCT_DISCOVERY',
    }), false);
});
//# sourceMappingURL=conversation-tone.util.test.js.map