"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const context_aware_reply_util_1 = require("./context-aware-reply.util");
const baseTone = {
    conversationTone: 'neutral',
    lastToneLeadUsed: null,
    allowPaymentSuggestion: false,
    followUpOfferedProductKey: null,
};
(0, node_test_1.default)('answers price question first from conversation history — one sentence, no payment pitch', () => {
    const r = (0, context_aware_reply_util_1.buildContextAwareReply)({
        intent: 'product_question',
        state: 'PRODUCT_DISCOVERY',
        previousState: 'PRODUCT_DISCOVERY',
        lastUserMessage: "What's the price?",
        conversationHistory: [
            {
                role: 'assistant',
                content: "Yes, I found Dune. It's available for $12. I can send you the payment link if you'd like.",
            },
        ],
        ...baseTone,
    });
    strict_1.default.ok(r);
    strict_1.default.equal(r?.questionAnsweredFirst, true);
    strict_1.default.match(r?.text ?? '', /\$12/);
    strict_1.default.equal(r?.paymentSuggestionUsed, false);
    strict_1.default.equal((r?.text.match(/\./g) ?? []).length, 1);
});
(0, node_test_1.default)('defers store identity to OpenAI (no canned script)', () => {
    const r = (0, context_aware_reply_util_1.buildContextAwareReply)({
        intent: 'store_identity_question',
        state: 'IDLE',
        previousState: 'IDLE',
        lastUserMessage: 'What store is this?',
        conversationHistory: [],
        ...baseTone,
    });
    strict_1.default.equal(r, null);
});
(0, node_test_1.default)('handles correction without "let me check" phrasing', () => {
    const r = (0, context_aware_reply_util_1.buildContextAwareReply)({
        intent: 'correction',
        state: 'PRODUCT_DISCOVERY',
        previousState: 'PRODUCT_DISCOVERY',
        lastUserMessage: 'No, I meant paperback',
        conversationHistory: [],
        ...baseTone,
    });
    strict_1.default.ok(r);
    strict_1.default.equal(r?.interruptionHandled, true);
    strict_1.default.match(r?.text ?? '', /paperback/i);
    strict_1.default.doesNotMatch(r?.text ?? '', /let me check/i);
});
(0, node_test_1.default)('skips repeating Got it when last lead was Got it', () => {
    const r = (0, context_aware_reply_util_1.buildContextAwareReply)({
        intent: 'correction',
        state: 'PRODUCT_DISCOVERY',
        previousState: 'PRODUCT_DISCOVERY',
        lastUserMessage: 'No, hardcover',
        conversationHistory: [],
        conversationTone: 'neutral',
        lastToneLeadUsed: 'Got it,',
        allowPaymentSuggestion: false,
        followUpOfferedProductKey: null,
    });
    strict_1.default.ok(r);
    strict_1.default.doesNotMatch(r?.text ?? '', /^Got it,/);
});
(0, node_test_1.default)('purchase flow copy comes from OpenAI, not context-aware templates', () => {
    const r = (0, context_aware_reply_util_1.buildContextAwareReply)({
        intent: 'purchase_confirmation',
        state: 'IDLE',
        previousState: 'IDLE',
        lastUserMessage: 'Yes, I want to buy',
        conversationHistory: [],
        ...baseTone,
    });
    strict_1.default.equal(r, null);
});
//# sourceMappingURL=context-aware-reply.util.test.js.map