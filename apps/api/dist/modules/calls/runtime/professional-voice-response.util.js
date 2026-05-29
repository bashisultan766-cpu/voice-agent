"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildProfessionalResponse = buildProfessionalResponse;
const conversation_tone_util_1 = require("./conversation-tone.util");
const voice_email_capture_util_1 = require("./voice-email-capture.util");
const product_follow_up_util_1 = require("./product-follow-up.util");
const PAYMENT_SUGGESTION_PHRASES = [
    'Want me to email you the checkout link?',
    'Would you like me to send the payment link by email?',
    'If you want, I can send the checkout link to your email.',
];
function pickVariant(seed, options) {
    let h = 0;
    for (let i = 0; i < seed.length; i += 1)
        h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return options[h % options.length];
}
function buildProfessionalResponse(args) {
    const { state, product, email, found } = args;
    const trimmedEmail = email?.trim() ?? '';
    const tone = args.tone;
    if (state === 'DONE') {
        return {
            text: pickVariant('done_closing', [
                "You'll receive the payment link shortly. Let me know if you need anything else.",
                "The payment link is on its way. If you need anything else, I'm here.",
            ]),
            templateKey: 'done_closing',
            toneLeadUsed: null,
            paymentSuggestionUsed: false,
        };
    }
    if (trimmedEmail) {
        if (state === 'EMAIL_CONFIRMING') {
            return {
                text: (0, voice_email_capture_util_1.buildEmailConfirmationPrompt)(trimmedEmail),
                templateKey: 'email_confirm',
                toneLeadUsed: null,
                paymentSuggestionUsed: false,
            };
        }
        if (tone) {
            const { lead, toneLeadUsed } = (0, conversation_tone_util_1.resolveToneLead)({
                slot: 'email_ack',
                conversationTone: tone.conversationTone,
                lastToneLeadUsed: tone.lastToneLeadUsed,
            });
            const text = lead
                ? `${lead} I'll send the payment link to ${trimmedEmail}.`
                : `I'll send the payment link to ${trimmedEmail}.`;
            return {
                text,
                templateKey: 'email_ack',
                toneLeadUsed,
                paymentSuggestionUsed: (0, conversation_tone_util_1.responseIncludesPaymentSuggestion)(text),
            };
        }
        return {
            text: `Perfect, I'll send the payment link to ${trimmedEmail}.`,
            templateKey: 'email_ack',
            toneLeadUsed: 'Perfect,',
            paymentSuggestionUsed: false,
        };
    }
    if (state === 'EMAIL_COLLECTION' || state === 'EMAIL_COLLECTING') {
        if (tone) {
            const { lead, toneLeadUsed } = (0, conversation_tone_util_1.resolveToneLead)({
                slot: 'email',
                conversationTone: tone.conversationTone,
                lastToneLeadUsed: tone.lastToneLeadUsed,
            });
            const collectionPrompt = (0, voice_email_capture_util_1.buildEmailCollectionPrompt)();
            const text = lead ? `${lead} ${collectionPrompt}` : collectionPrompt;
            return {
                text,
                templateKey: 'ask_email',
                toneLeadUsed,
                paymentSuggestionUsed: false,
            };
        }
        return {
            text: (0, voice_email_capture_util_1.buildEmailCollectionPrompt)(),
            templateKey: 'ask_email',
            toneLeadUsed: null,
            paymentSuggestionUsed: false,
        };
    }
    if (state === 'PRODUCT_DISCOVERY') {
        if (found && product?.title?.trim()) {
            const title = product.title.trim();
            const price = product.price?.trim() ?? '';
            const { lead, toneLeadUsed } = tone
                ? (0, conversation_tone_util_1.resolveToneLead)({
                    slot: 'product_found',
                    conversationTone: tone.conversationTone,
                    lastToneLeadUsed: tone.lastToneLeadUsed,
                })
                : { lead: 'Yes,', toneLeadUsed: 'Yes,' };
            const prefix = lead ? `${lead} ` : '';
            const core = price
                ? `${prefix}I found ${title}. It's available for ${price}.`
                : `${prefix}I found ${title}.`;
            const wantPayment = args.includePaymentSuggestion === true;
            const productKey = (0, product_follow_up_util_1.normalizeProductFollowUpKey)(title);
            const paymentSuggestionPhrase = pickVariant(`pay_${productKey || title}`, PAYMENT_SUGGESTION_PHRASES);
            const prevOffered = typeof args.followUpOfferedProductKey === 'string' && args.followUpOfferedProductKey.trim()
                ? args.followUpOfferedProductKey.trim()
                : null;
            const shouldSoftFollowUp = !wantPayment && prevOffered !== productKey;
            let followUpTriggered = false;
            let text;
            if (wantPayment) {
                text = `${core} ${paymentSuggestionPhrase}`;
            }
            else if (shouldSoftFollowUp) {
                text = `${core} ${paymentSuggestionPhrase}`;
                followUpTriggered = true;
            }
            else {
                text = core;
            }
            return {
                text,
                templateKey: 'product_found_offer_link',
                toneLeadUsed,
                paymentSuggestionUsed: wantPayment,
                ...(followUpTriggered ? { followUpTriggered: true, followUpOfferedProductKey: productKey } : {}),
            };
        }
        return {
            text: pickVariant(`not_found_${state}`, [
                "I couldn't find an exact match, but I can check similar titles. Could you repeat the title or author?",
                "That exact title didn't come up. Could you spell it or share the author name?",
            ]),
            templateKey: 'product_not_found',
            toneLeadUsed: null,
            paymentSuggestionUsed: false,
        };
    }
    return {
        text: pickVariant('idle_clarify', [
            'Which book do you need? Please tell me the title first.',
            'Tell me the book title and I will check it for you.',
        ]),
        templateKey: 'idle_clarify',
        toneLeadUsed: null,
        paymentSuggestionUsed: false,
    };
}
//# sourceMappingURL=professional-voice-response.util.js.map