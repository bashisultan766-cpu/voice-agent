"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const response_mode_util_1 = require("./response-mode.util");
(0, node_test_1.default)('uses openai for exact catalog match (natural conversation)', () => {
    const mode = (0, response_mode_util_1.decideResponseMode)({
        intent: 'product_search',
        state: 'PRODUCT_DISCOVERY',
        toolResult: {
            searchProducts: {
                ok: true,
                found: true,
                title: 'Dune',
                price: '$12',
                requiresClarification: false,
            },
        },
        customerText: 'Do you have Atomic Habits?',
    });
    strict_1.default.equal(mode, 'openai');
});
(0, node_test_1.default)('uses openai in email collection without tool trace', () => {
    const mode = (0, response_mode_util_1.decideResponseMode)({
        intent: 'purchase_confirmation',
        state: 'EMAIL_COLLECTION',
        customerText: 'Yes send link',
    });
    strict_1.default.equal(mode, 'openai');
});
(0, node_test_1.default)('uses openai when customer speaks an email but no validateEmail tool trace yet', () => {
    const mode = (0, response_mode_util_1.decideResponseMode)({
        intent: 'email_provided',
        state: 'PRODUCT_DISCOVERY',
        customerText: 'my email is reader@example.com',
    });
    strict_1.default.equal(mode, 'openai');
});
(0, node_test_1.default)('uses openai for greeting', () => {
    const mode = (0, response_mode_util_1.decideResponseMode)({
        intent: 'greeting',
        state: 'IDLE',
        customerText: 'hello there',
    });
    strict_1.default.equal(mode, 'openai');
});
(0, node_test_1.default)('uses openai for product question with existing context', () => {
    const mode = (0, response_mode_util_1.decideResponseMode)({
        intent: 'product_question',
        state: 'PRODUCT_DISCOVERY',
        customerText: "What's the price?",
    });
    strict_1.default.equal(mode, 'openai');
});
(0, node_test_1.default)('uses openai for payment email tool trace (success or failure)', () => {
    const modeOk = (0, response_mode_util_1.decideResponseMode)({
        intent: 'email_provided',
        state: 'EMAIL_COLLECTION',
        customerText: 'reader@example.com',
        toolResult: {
            sendPaymentEmail: {
                ok: true,
                email: 'reader@example.com',
            },
        },
    });
    strict_1.default.equal(modeOk, 'openai');
    const modeFail = (0, response_mode_util_1.decideResponseMode)({
        intent: 'email_provided',
        state: 'EMAIL_COLLECTION',
        customerText: 'reader@example.com',
        toolResult: {
            sendPaymentEmail: {
                ok: false,
                email: 'reader@example.com',
            },
        },
    });
    strict_1.default.equal(modeFail, 'openai');
});
(0, node_test_1.default)('uses openai for Shopify catalog hard failure', () => {
    const mode = (0, response_mode_util_1.decideResponseMode)({
        intent: 'product_search',
        state: 'PRODUCT_DISCOVERY',
        toolResult: {
            searchProducts: {
                ok: false,
                found: false,
                requiresClarification: false,
                errorCode: 'SHOPIFY_SEARCH_FAILED',
            },
        },
        customerText: 'Dune',
    });
    strict_1.default.equal(mode, 'openai');
});
(0, node_test_1.default)('uses openai when search tool blocked by policy (not a catalog outage)', () => {
    const mode = (0, response_mode_util_1.decideResponseMode)({
        intent: 'greeting',
        state: 'IDLE',
        toolResult: {
            searchProducts: {
                ok: false,
                found: false,
                requiresClarification: false,
                errorCode: 'TOOL_BLOCKED_BY_INTENT',
            },
        },
        customerText: 'hi',
    });
    strict_1.default.equal(mode, 'openai');
});
(0, node_test_1.default)('uses template for invalid email from validateEmail tool', () => {
    const mode = (0, response_mode_util_1.decideResponseMode)({
        intent: 'email_provided',
        state: 'EMAIL_COLLECTION',
        toolResult: {
            validateEmail: { valid: false, email: null },
        },
        customerText: 'not an email',
    });
    strict_1.default.equal(mode, 'template');
});
(0, node_test_1.default)('uses openai for small talk', () => {
    const mode = (0, response_mode_util_1.decideResponseMode)({
        intent: 'small_talk',
        state: 'PRODUCT_DISCOVERY',
        customerText: 'how are you?',
    });
    strict_1.default.equal(mode, 'openai');
});
//# sourceMappingURL=response-mode.util.test.js.map