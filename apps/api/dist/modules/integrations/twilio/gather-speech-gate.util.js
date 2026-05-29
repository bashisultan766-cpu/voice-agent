"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasMeaningfulSpeech = hasMeaningfulSpeech;
exports.rejectReasonForSpeech = rejectReasonForSpeech;
exports.computeGatherSpeechGate = computeGatherSpeechGate;
const MEANINGLESS_SPEECH = new Set(['.', '...', 'uh', 'um', 'hmm']);
function hasMeaningfulSpeech(text) {
    if (!text)
        return false;
    const cleaned = text.trim().toLowerCase();
    if (cleaned.length < 2)
        return false;
    if (MEANINGLESS_SPEECH.has(cleaned))
        return false;
    return true;
}
function mergeGatherSpeechText(input) {
    const speechResult = (input.SpeechResult ?? '').trim();
    const stable = (input.StableSpeechResult ?? '').trim();
    return speechResult || stable;
}
function parseConfidenceForLog(confidenceRaw) {
    const confidenceStr = (confidenceRaw ?? '').trim();
    if (confidenceStr === '')
        return null;
    const parsed = Number(confidenceStr);
    return Number.isFinite(parsed) ? parsed : null;
}
function rejectReasonForSpeech(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return 'empty';
    if (!hasMeaningfulSpeech(text)) {
        const cleaned = trimmed.toLowerCase();
        if (cleaned.length < 2)
            return 'too_short';
        return 'noise_only';
    }
    return null;
}
function computeGatherSpeechGate(input) {
    const speechTextMerged = mergeGatherSpeechText(input);
    const hasUsableSpeech = hasMeaningfulSpeech(speechTextMerged);
    const willCallVoiceRuntime = hasUsableSpeech;
    const confidenceParsed = parseConfidenceForLog(input.Confidence);
    const rejectReason = hasUsableSpeech ? null : rejectReasonForSpeech(speechTextMerged);
    return {
        speechTextMerged,
        hasUsableSpeech,
        willCallVoiceRuntime,
        confidenceParsed,
        speechAccepted: hasUsableSpeech,
        acceptReason: hasUsableSpeech ? 'meaningful_text' : null,
        rejectReason,
    };
}
//# sourceMappingURL=gather-speech-gate.util.js.map