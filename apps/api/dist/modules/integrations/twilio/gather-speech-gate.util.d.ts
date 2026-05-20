export type GatherSpeechGateInput = {
    SpeechResult?: string;
    StableSpeechResult?: string;
    Confidence?: string;
};
export declare function computeGatherSpeechGate(input: GatherSpeechGateInput): {
    speechTextMerged: string;
    hasUsableSpeech: boolean;
    willCallVoiceRuntime: boolean;
    confidenceParsed: number | null;
    confidenceIgnored: true;
    speechAccepted: boolean;
};
