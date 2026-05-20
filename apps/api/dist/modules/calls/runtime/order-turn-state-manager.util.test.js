"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const order_turn_state_manager_util_1 = require("./order-turn-state-manager.util");
const order_intent_classifier_util_1 = require("./order-intent-classifier.util");
function step(state, utterance) {
    const cls = (0, order_intent_classifier_util_1.classifyOrderTurn)(utterance);
    const res = (0, order_turn_state_manager_util_1.applyTurnToOrderState)(state, cls.intent, cls);
    return { cls, res };
}
(0, node_test_1.default)('bookstore flow: product search then confirm goes to email collection', () => {
    let s = 'IDLE';
    ({ res: { nextState: s } } = step(s, 'I want Atomic Habits'));
    strict_1.default.equal(s, 'PRODUCT_DISCOVERY');
    ({ res: { nextState: s } } = step(s, 'Yes'));
    strict_1.default.equal(s, 'EMAIL_COLLECTION');
});
(0, node_test_1.default)('unclear product: recovery prompt in discovery', () => {
    const { res } = step('PRODUCT_DISCOVERY', 'uhm');
    strict_1.default.equal(res.nextState, 'PRODUCT_DISCOVERY');
    strict_1.default.ok(res.recoveryPrompt);
});
(0, node_test_1.default)('invalid email retry: stays in EMAIL_COLLECTION', () => {
    const { res } = step('EMAIL_COLLECTION', 'not-an-email');
    strict_1.default.equal(res.nextState, 'EMAIL_COLLECTION');
    strict_1.default.equal(res.recoveryPrompt?.key, 'INVALID_EMAIL');
});
(0, node_test_1.default)('user cancels: transitions to DONE', () => {
    const { res } = step('PRODUCT_DISCOVERY', 'cancel order');
    strict_1.default.equal(res.nextState, 'DONE');
    strict_1.default.equal(res.recoveryPrompt?.key, 'CHANGED_MIND');
});
(0, node_test_1.default)('general question mid-order: stays in product discovery', () => {
    const { cls, res } = step('PRODUCT_DISCOVERY', 'What is your return policy?');
    strict_1.default.equal(cls.intent, 'general_question');
    strict_1.default.equal(res.nextState, 'PRODUCT_DISCOVERY');
});
//# sourceMappingURL=order-turn-state-manager.util.test.js.map