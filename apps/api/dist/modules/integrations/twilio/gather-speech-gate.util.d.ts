export type GatherSpeechGateInput = {
    SpeechResult?: string;
    StableSpeechResult?: string;
    Confidence?: string;
};
export type GatherSpeechRejectReason = 'empty' | 'too_short' | 'noise_only';
export declare function hasMeaningfulSpeech(text: string | undefined | null): boolean;
export declare function rejectReasonForSpeech(text: string): GatherSpeechRejectReason | null;
export declare function computeGatherSpeechGate(input: GatherSpeechGateInput): {
    speechTextMerged: string;
    hasUsableSpeech: boolean;
    willCallVoiceRuntime: boolean;
    confidenceParsed: number | null;
    speechAccepted: boolean;
    acceptReason: 'meaningful_text' | null;
    rejectReason: GatherSpeechRejectReason | null;
};
