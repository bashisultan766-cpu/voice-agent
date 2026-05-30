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
    strict_1.default.equal(s, 'PRODUCT_SEARCH');
    ({ res: { nextState: s } } = step(s, 'Yes'));
    strict_1.default.equal(s, 'PRODUCT_CONFIRMED');
});
(0, node_test_1.default)('unclear product: recovery prompt in discovery', () => {
    const { res } = step('PRODUCT_SEARCH', 'uhm');
    strict_1.default.equal(res.nextState, 'PRODUCT_SEARCH');
    strict_1.default.ok(res.recoveryPrompt);
});
(0, node_test_1.default)('invalid email retry: stays in EMAIL_COLLECTION', () => {
    const { res } = step('EMAIL_COLLECTING', 'not-an-email');
    strict_1.default.equal(res.nextState, 'EMAIL_COLLECTING');
    strict_1.default.equal(res.recoveryPrompt?.key, 'INVALID_EMAIL');
});
(0, node_test_1.default)('EMAIL_COLLECTION + product query interrupts recovery and returns to discovery', () => {
    const cls = (0, order_intent_classifier_util_1.classifyOrderTurn)('You have Game of Thrones');
    const res = (0, order_turn_state_manager_util_1.applyTurnToOrderState)('EMAIL_COLLECTION', cls.intent, cls, {
        alternateIntent: 'product_search',
        alternateIntentConfidence: 0.92,
    });
    strict_1.default.equal(res.nextState, 'PRODUCT_DISCOVERY');
    strict_1.default.equal(res.recoveryPrompt, undefined);
    strict_1.default.equal(res.stateInterrupted?.toIntent, 'product_search');
});
(0, node_test_1.default)('interrupt rules require high confidence alternate intent', () => {
    const low = (0, order_turn_state_manager_util_1.canInterruptCurrentState)('product_search', 'EMAIL_COLLECTION', 0.4);
    strict_1.default.equal(low.canInterrupt, false);
    const high = (0, order_turn_state_manager_util_1.canInterruptCurrentState)('product_search', 'EMAIL_COLLECTION', 0.9);
    strict_1.default.equal(high.canInterrupt, true);
});
(0, node_test_1.default)('user cancels: transitions to DONE', () => {
    const { res } = step('PRODUCT_DISCOVERY', 'cancel order');
    strict_1.default.equal(res.nextState, 'DONE');
    strict_1.default.equal(res.recoveryPrompt?.key, 'CHANGED_MIND');
});
(0, node_test_1.default)('general question mid-order: stays in product discovery', () => {
    const { cls, res } = step('PRODUCT_SEARCH', 'What is your return policy?');
    strict_1.default.equal(cls.intent, 'general_question');
    strict_1.default.equal(res.nextState, 'PRODUCT_SEARCH');
});
(0, node_test_1.default)('quantity then email progresses to email confirming', () => {
    let s = 'PRODUCT_CONFIRMED';
    ({ res: { nextState: s } } = step(s, '2 copies please'));
    strict_1.default.equal(s, 'QUANTITY_COLLECTED');
    ({ res: { nextState: s } } = step(s, 'reader@gmail.com'));
    strict_1.default.equal(s, 'EMAIL_CONFIRMING');
});
(0, node_test_1.default)('email confirmation moves checkout to payment link creating', () => {
    const { res } = step('EMAIL_CONFIRMING', 'yes');
    strict_1.default.equal(res.nextState, 'PAYMENT_LINK_CREATING');
});
//# sourceMappingURL=order-turn-state-manager.util.test.js.map