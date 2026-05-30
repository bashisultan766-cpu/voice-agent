"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isYesNoOnlyUtterance = isYesNoOnlyUtterance;
exports.isLikelyProductCorrection = isLikelyProductCorrection;
exports.selectInstantAcknowledgement = selectInstantAcknowledgement;
exports.buildInstantAckMetadataPatch = buildInstantAckMetadataPatch;
const instant_reply_util_1 = require("../../calls/runtime/instant-reply.util");
const ORDER_DETAIL_STATES = new Set(['EMAIL_COLLECTION']);
function normalizeQuery(s) {
    return s.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
}
function extractEmail(text) {
    const m = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return m ? m[0] : null;
}
function isYesNoOnlyUtterance(text) {
    return /^(yes|yeah|yep|yup|no|nope|nah|naw)\.?$/i.test(text.trim());
}
function isLikelyProductCorrection(text) {
    const t = text.toLowerCase();
    return (/\b(no|nope|not)\b.*\b(mean|meant|actually)\b|\bi mean\b|\b(instead|rather)\b|\bwrong (book|one|title|item)\b|\bnot that\b|\bdifferent (book|one|title)\b/i.test(t) || /^no,?\s+i\s+mean\b/i.test(t));
}
function selectInstantAcknowledgement(input) {
    const { intent, speechText, callState, metadata, forceElevenLabsOnly = false } = input;
    const trimmed = speechText.trim();
    const orderState = callState.trim() || 'IDLE';
    const normQ = normalizeQuery(trimmed);
    const prevProduct = typeof metadata.lastProductQuery === 'string' ? metadata.lastProductQuery : null;
    if ((0, instant_reply_util_1.shouldUseInstantReply)(trimmed, orderState) && orderState === 'IDLE' && !forceElevenLabsOnly) {
        return {
            mode: 'sync_full_reply',
            ackReason: 'instant_deterministic_sync',
        };
    }
    if (intent === 'greeting' || intent === 'small_talk') {
        return {
            mode: 'deferred_kickoff',
            instantPhrase: null,
            ackReason: 'idle_greeting_or_small_talk_deferred',
            markSessionLetMeCheck: false,
        };
    }
    if (intent === 'store_identity_question' || intent === 'capability_question') {
        return {
            mode: 'deferred_kickoff',
            instantPhrase: null,
            ackReason: 'identity_or_capability_question_deferred',
            markSessionLetMeCheck: false,
        };
    }
    if (isYesNoOnlyUtterance(trimmed) && callState !== 'IDLE') {
        return {
            mode: 'deferred_kickoff',
            instantPhrase: null,
            ackReason: 'yes_no_in_flow',
            markSessionLetMeCheck: false,
        };
    }
    const hasEmail = Boolean(extractEmail(trimmed));
    const emailProvisionCue = /\b(my email|email is|e-?mail is|it'?s |the email is|spell(?:ing)? (?:my )?email)\b/i.test(trimmed);
    if (hasEmail && (callState === 'EMAIL_COLLECTION' || emailProvisionCue)) {
        return {
            mode: 'deferred_kickoff',
            instantPhrase: null,
            ackReason: 'email_provided',
            markSessionLetMeCheck: false,
        };
    }
    if (ORDER_DETAIL_STATES.has(callState)) {
        if (!isYesNoOnlyUtterance(trimmed) && intent !== 'product_search' && !hasEmail) {
            return {
                mode: 'deferred_kickoff',
                instantPhrase: null,
                ackReason: 'email_phase_listen',
                markSessionLetMeCheck: false,
            };
        }
    }
    const productSearchAck = !forceElevenLabsOnly ? instant_reply_util_1.VOICE_CACHED_PHRASES.searchAckShort : null;
    if (intent === 'product_search') {
        if (isLikelyProductCorrection(trimmed)) {
            return {
                mode: 'deferred_kickoff',
                instantPhrase: forceElevenLabsOnly ? null : instant_reply_util_1.VOICE_CACHED_PHRASES.productCorrection,
                ackReason: 'product_correction',
                markSessionLetMeCheck: !forceElevenLabsOnly,
                nextLastProductQuery: normQ || null,
            };
        }
        if (prevProduct && normQ === prevProduct) {
            return {
                mode: 'deferred_kickoff',
                instantPhrase: productSearchAck,
                ackReason: 'product_search_repeat_same_query',
                markSessionLetMeCheck: false,
                nextLastProductQuery: normQ || null,
            };
        }
        return {
            mode: 'deferred_kickoff',
            instantPhrase: productSearchAck,
            ackReason: productSearchAck ? 'product_search_instant_ack' : 'product_search_silent_kickoff',
            markSessionLetMeCheck: Boolean(productSearchAck),
            nextLastProductQuery: normQ || null,
        };
    }
    if (intent === 'payment_question' || intent === 'product_question') {
        return {
            mode: 'deferred_kickoff',
            instantPhrase: forceElevenLabsOnly ? null : instant_reply_util_1.PRODUCT_SEARCH_FAST_ACK,
            ackReason: 'question_requires_direct_answer_deferred',
            markSessionLetMeCheck: !forceElevenLabsOnly,
        };
    }
    if (intent === 'purchase_confirmation') {
        return {
            mode: 'deferred_kickoff',
            instantPhrase: null,
            ackReason: 'purchase_confirmation_silent',
            markSessionLetMeCheck: false,
        };
    }
    if (isYesNoOnlyUtterance(trimmed)) {
        return {
            mode: 'deferred_kickoff',
            instantPhrase: null,
            ackReason: 'yes_no_idle',
            markSessionLetMeCheck: false,
        };
    }
    return {
        mode: 'deferred_kickoff',
        instantPhrase: null,
        ackReason: 'silent_default',
        markSessionLetMeCheck: false,
    };
}
function buildInstantAckMetadataPatch(args) {
    const { selection, intent, letMeCheckUsedBefore, instantPhraseForLog, syncReplyText } = args;
    let letMeCheckUsedAfter = letMeCheckUsedBefore;
    if (selection.mode === 'deferred_kickoff' && selection.markSessionLetMeCheck) {
        letMeCheckUsedAfter = true;
    }
    const lastInstantAck = selection.mode === 'sync_full_reply'
        ? (syncReplyText ?? '').trim() || '(sync_reply)'
        : instantPhraseForLog === null
            ? '(silent)'
            : instantPhraseForLog;
    let lastProductQuery;
    if (selection.mode === 'deferred_kickoff' && selection.nextLastProductQuery !== undefined) {
        lastProductQuery = selection.nextLastProductQuery;
    }
    return {
        lastInstantAck: lastInstantAck.slice(0, 500),
        lastIntentDetected: intent,
        letMeCheckUsed: letMeCheckUsedAfter,
        ...(lastProductQuery !== undefined ? { lastProductQuery } : {}),
    };
}
//# sourceMappingURL=instant-acknowledgement.util.js.map