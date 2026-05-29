"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getIntentPriority = getIntentPriority;
exports.canInterruptCurrentState = canInterruptCurrentState;
exports.applyTurnToOrderState = applyTurnToOrderState;
exports.recoveryPromptText = recoveryPromptText;
const order_state_machine_util_1 = require("./order-state-machine.util");
const voice_email_capture_util_1 = require("./voice-email-capture.util");
const INTERRUPTIBLE_INTENTS = new Set([
    'product_search',
    'order_lookup',
    'support_question',
    'pricing_question',
]);
const INTERRUPTIBLE_STATES = new Set([
    'EMAIL_COLLECTION',
    'PAYMENT_COLLECTION',
    'EMAIL_COLLECTING',
    'EMAIL_CONFIRMING',
]);
function getIntentPriority(intent) {
    const i = intent.trim().toLowerCase();
    if (i === 'product_search')
        return 100;
    if (i === 'order_lookup')
        return 95;
    if (i === 'support_question')
        return 90;
    if (i === 'pricing_question')
        return 85;
    if (i === 'email_collection_recovery')
        return 60;
    return 0;
}
function canInterruptCurrentState(intent, state, confidence = 1) {
    const normalizedState = `${state ?? ''}`.trim().toUpperCase();
    const normalizedIntent = intent.trim().toLowerCase();
    const highPriority = getIntentPriority(normalizedIntent) > getIntentPriority('email_collection_recovery');
    const intentAllowed = INTERRUPTIBLE_INTENTS.has(normalizedIntent);
    if (!INTERRUPTIBLE_STATES.has(normalizedState)) {
        return { canInterrupt: false, reason: 'state_not_interruptible' };
    }
    if (!intentAllowed) {
        return { canInterrupt: false, reason: 'intent_not_interruptible' };
    }
    if (confidence < 0.6) {
        return { canInterrupt: false, reason: 'alternate_intent_low_confidence' };
    }
    if (!highPriority) {
        return { canInterrupt: false, reason: 'alternate_intent_not_high_priority' };
    }
    return { canInterrupt: true, reason: 'high_confidence_alternate_intent' };
}
function applyTurnToOrderState(currentRaw, intent, cls, options) {
    const current = (0, order_state_machine_util_1.normalizeOrderState)(currentRaw);
    const currentName = `${currentRaw ?? current}`.trim() || current;
    const rawText = cls.rawText ?? '';
    const t = rawText.toLowerCase().trim();
    const alternateIntent = options?.alternateIntent?.trim().toLowerCase() ?? '';
    const alternateIntentConfidence = options?.alternateIntentConfidence ?? 0;
    const interruption = canInterruptCurrentState(alternateIntent, currentName, alternateIntentConfidence);
    if (interruption.canInterrupt) {
        return {
            nextState: 'PRODUCT_DISCOVERY',
            stateInterrupted: {
                fromState: currentName,
                toIntent: alternateIntent,
                reason: interruption.reason,
            },
        };
    }
    if (intent === 'cancel_order') {
        return { nextState: 'DONE', recoveryPrompt: { key: 'CHANGED_MIND' } };
    }
    if (intent === 'email_provided' && current === 'IDLE') {
        return { nextState: current, recoveryPrompt: { key: 'NEED_PRODUCT_FIRST' } };
    }
    switch (current) {
        case 'IDLE': {
            if (intent === 'product_search')
                return { nextState: 'PRODUCT_SEARCH' };
            return { nextState: 'IDLE' };
        }
        case 'PRODUCT_SEARCH': {
            if (intent === 'product_confirmed' || intent === 'order_confirmed') {
                return { nextState: 'PRODUCT_CONFIRMED' };
            }
            if (intent === 'email_provided')
                return { nextState: 'EMAIL_COLLECTING' };
            if (intent === 'product_search' || intent === 'variant_selected') {
                return { nextState: 'PRODUCT_SEARCH' };
            }
            if (intent === 'general_question') {
                const filler = t.length <= 6 && ['uh', 'uhm', 'um', 'hmm', 'okay', 'ok'].includes(t);
                if (filler || cls.confidence < 0.35) {
                    return { nextState: 'PRODUCT_SEARCH', recoveryPrompt: { key: 'UNCLEAR_PRODUCT' } };
                }
                return { nextState: 'PRODUCT_SEARCH' };
            }
            return { nextState: 'PRODUCT_SEARCH', recoveryPrompt: { key: 'UNCLEAR_PRODUCT' } };
        }
        case 'PRODUCT_CONFIRMED': {
            if (intent === 'quantity_provided')
                return { nextState: 'QUANTITY_COLLECTED' };
            if (intent === 'product_search')
                return { nextState: 'PRODUCT_SEARCH' };
            return { nextState: 'PRODUCT_CONFIRMED' };
        }
        case 'QUANTITY_COLLECTED': {
            if (intent === 'email_provided')
                return { nextState: 'EMAIL_CONFIRMING' };
            if (intent === 'product_search')
                return { nextState: 'PRODUCT_SEARCH' };
            return { nextState: 'EMAIL_COLLECTING' };
        }
        case 'EMAIL_COLLECTING': {
            if (intent === 'quantity_provided') {
                return { nextState: 'QUANTITY_COLLECTED', recoveryPrompt: { key: 'CONFIRM_QUANTITY' } };
            }
            if (intent === 'email_provided')
                return { nextState: 'EMAIL_CONFIRMING' };
            if (intent === 'general_question') {
                const wantsResend = /\b(resend|send again|didn't get|did not receive)\b/i.test(t);
                if (wantsResend) {
                    return { nextState: 'EMAIL_COLLECTING', recoveryPrompt: { key: 'RESEND_PAYMENT_LINK' } };
                }
                const looksLikeQuestion = t.includes('?') || t.startsWith('what ') || t.startsWith('how ') || t.startsWith('when ');
                if (looksLikeQuestion)
                    return { nextState: 'EMAIL_COLLECTING' };
                return { nextState: 'EMAIL_COLLECTING', recoveryPrompt: { key: 'INVALID_EMAIL' } };
            }
            if (intent === 'product_search')
                return { nextState: 'PRODUCT_SEARCH' };
            return { nextState: 'EMAIL_COLLECTING', recoveryPrompt: { key: 'INVALID_EMAIL' } };
        }
        case 'EMAIL_CONFIRMING': {
            if (intent === 'order_confirmed')
                return { nextState: 'PAYMENT_LINK_CREATING' };
            if (intent === 'email_provided')
                return { nextState: 'EMAIL_CONFIRMING' };
            if ((0, voice_email_capture_util_1.isEmailConfirmationNegative)(t)) {
                return { nextState: 'EMAIL_COLLECTING', recoveryPrompt: { key: 'INVALID_EMAIL' } };
            }
            if (intent === 'product_search')
                return { nextState: 'PRODUCT_SEARCH' };
            return { nextState: 'EMAIL_CONFIRMING' };
        }
        case 'PAYMENT_LINK_CREATING': {
            return { nextState: 'PAYMENT_LINK_CREATING' };
        }
        case 'PAYMENT_LINK_SENT': {
            return { nextState: 'PAYMENT_LINK_SENT' };
        }
        case 'DONE': {
            return { nextState: 'DONE' };
        }
        default:
            return { nextState: (0, order_state_machine_util_1.normalizeOrderState)(current) };
    }
}
function recoveryPromptText(languageCode, key) {
    const lang = (languageCode ?? 'en').toLowerCase().trim();
    const L = (en, it, ru) => (lang === 'it' ? it ?? en : lang === 'ru' ? ru ?? en : en);
    switch (key) {
        case 'UNCLEAR_PRODUCT':
            return L('Which book do you need? Tell me the title first.', 'Puoi dirmi il titolo del libro o l’ISBN?', 'Назовите название книги или ISBN, пожалуйста.');
        case 'INVALID_EMAIL':
            return L((0, voice_email_capture_util_1.buildInvalidEmailRetryPrompt)(1), 'Scusa, non mi è sembrata un’email completa—puoi ripeterla lentamente?', 'Похоже, email получился неполным — повторите медленно, пожалуйста.');
        case 'CHANGED_MIND':
            return L('No problem. If you want a book, tell me the title first.', 'Nessun problema. Se vuoi un libro, dimmi il titolo o l’ISBN.', 'Хорошо. Если нужна книга, назовите название или ISBN.');
        case 'NEED_PRODUCT_FIRST':
            return L('Sure. Tell me the book title first.', 'Quale libro cerchi—titolo o ISBN?', 'Какую книгу ищем—название или ISBN?');
        case 'CONFIRM_QUANTITY':
            return L('Got it. How many copies should I put on the checkout link?', 'Perfetto. Quante copie vuoi?', 'Сколько экземпляров добавить в заказ?');
        case 'RESEND_PAYMENT_LINK':
            return L('I can resend the checkout link—what email should I use?', 'Posso reinviare il link—quale email uso?', 'Могу отправить ссылку снова — какой email?');
        default:
            return L('Could you repeat that?', 'Puoi ripetere?', 'Повторите, пожалуйста.');
    }
}
//# sourceMappingURL=order-turn-state-manager.util.js.map