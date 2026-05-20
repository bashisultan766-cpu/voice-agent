"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectConversationTone = detectConversationTone;
exports.resolveToneLead = resolveToneLead;
exports.computeAllowPaymentSuggestion = computeAllowPaymentSuggestion;
exports.responseIncludesPaymentSuggestion = responseIncludesPaymentSuggestion;
const LEAD_YES = 'Yes,';
const LEAD_GOT_IT = 'Got it,';
const LEAD_SURE = 'Sure,';
const LEAD_ALRIGHT = 'Alright,';
const LEAD_ABSOLUTELY = 'Absolutely,';
const LEAD_PERFECT = 'Perfect,';
const LEAD_OKAY = 'Okay,';
function detectConversationTone(text) {
    const t = text.trim();
    const lower = t.toLowerCase();
    const words = t.split(/\s+/).filter(Boolean);
    if (/\b(thanks|thank you|thx|please|appreciate|appreciated|wonderful|lovely|great to|nice to)\b/i.test(lower) ||
        /\b(how are you|hope you|have a good)\b/i.test(lower)) {
        return 'friendly';
    }
    if (words.length <= 3 && t.length <= 24 && !t.includes('?')) {
        return 'direct';
    }
    return 'neutral';
}
function resolveToneLead(args) {
    const last = (args.lastToneLeadUsed ?? '').trim();
    const pick = (candidates) => {
        const filtered = candidates.filter((x) => x !== last);
        const choice = (filtered[0] ?? candidates[0] ?? '').trim();
        return choice ? { lead: choice, toneLeadUsed: choice } : { lead: '', toneLeadUsed: null };
    };
    if (args.slot === 'none') {
        return { lead: '', toneLeadUsed: null };
    }
    if (args.slot === 'product_found') {
        if (args.conversationTone === 'friendly') {
            return pick([LEAD_YES, LEAD_ABSOLUTELY, LEAD_PERFECT]);
        }
        return pick([LEAD_YES, LEAD_ALRIGHT]);
    }
    if (args.slot === 'correction') {
        return pick([LEAD_GOT_IT, LEAD_OKAY, LEAD_ALRIGHT]);
    }
    if (args.slot === 'email') {
        return pick([LEAD_SURE, LEAD_PERFECT, LEAD_ALRIGHT]);
    }
    if (args.slot === 'email_ack') {
        return pick([LEAD_GOT_IT, LEAD_PERFECT, LEAD_OKAY]);
    }
    if (args.slot === 'price') {
        if (args.conversationTone === 'direct') {
            return { lead: '', toneLeadUsed: null };
        }
        return pick([LEAD_ALRIGHT, LEAD_OKAY]);
    }
    return { lead: '', toneLeadUsed: null };
}
function computeAllowPaymentSuggestion(args) {
    if (args.userIntent === 'purchase_confirmation')
        return true;
    if (args.orderState === 'EMAIL_COLLECTION')
        return true;
    if (args.clsIntent === 'product_confirmed' || args.clsIntent === 'order_confirmed')
        return true;
    return false;
}
function responseIncludesPaymentSuggestion(text) {
    const t = text.toLowerCase();
    return t.includes('checkout link') || t.includes('payment link');
}
//# sourceMappingURL=conversation-tone.util.js.map