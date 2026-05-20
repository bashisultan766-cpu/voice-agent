"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const user_intent_classifier_util_1 = require("./user-intent-classifier.util");
(0, node_test_1.default)('classifies payment question', () => {
    strict_1.default.equal((0, user_intent_classifier_util_1.classifyUserIntent)('How does payment work?'), 'payment_question');
});
(0, node_test_1.default)('classifies store identity question', () => {
    strict_1.default.equal((0, user_intent_classifier_util_1.classifyUserIntent)('What store is this?'), 'store_identity_question');
});
(0, node_test_1.default)('classifies store category question', () => {
    strict_1.default.equal((0, user_intent_classifier_util_1.classifyUserIntent)('Can I get sports products here?'), 'store_category_question');
});
(0, node_test_1.default)('classifies capability question', () => {
    strict_1.default.equal((0, user_intent_classifier_util_1.classifyUserIntent)('How can you help me?'), 'capability_question');
});
(0, node_test_1.default)('classifies general business question', () => {
    strict_1.default.equal((0, user_intent_classifier_util_1.classifyUserIntent)('How does this work?'), 'general_business_question');
});
(0, node_test_1.default)('classifies email provided', () => {
    strict_1.default.equal((0, user_intent_classifier_util_1.classifyUserIntent)('my email is user@example.com'), 'email_provided');
});
(0, node_test_1.default)('classifies correction', () => {
    strict_1.default.equal((0, user_intent_classifier_util_1.classifyUserIntent)('No, I mean the paperback edition'), 'correction');
});
(0, node_test_1.default)('classifies purchase confirmation', () => {
    strict_1.default.equal((0, user_intent_classifier_util_1.classifyUserIntent)('Yes, I want to buy it'), 'purchase_confirmation');
});
(0, node_test_1.default)('classifies vague short turns as unclear', () => {
    strict_1.default.equal((0, user_intent_classifier_util_1.classifyUserIntent)('uh maybe'), 'unclear');
});
//# sourceMappingURL=user-intent-classifier.util.test.js.map