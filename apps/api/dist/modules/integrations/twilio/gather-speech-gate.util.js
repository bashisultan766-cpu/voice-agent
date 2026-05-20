"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeGatherSpeechGate = computeGatherSpeechGate;
function computeGatherSpeechGate(input) {
    const { SpeechResult, StableSpeechResult, Confidence } = input;
    const speechTextMerged = [SpeechResult, StableSpeechResult]
        .filter(Boolean)
        .join(" ")
        .trim();
    const hasUsableSpeech = speechTextMerged.length >= 2;
    const willCallVoiceRuntime = hasUsableSpeech;
    const confidenceParsed = Confidence ? Number(Confidence) : null;
    return {
        speechTextMerged,
        hasUsableSpeech,
        willCallVoiceRuntime,
        confidenceParsed,
        confidenceIgnored: true,
        speechAccepted: hasUsableSpeech
    };
}
//# sourceMappingURL=gather-speech-gate.util.js.map