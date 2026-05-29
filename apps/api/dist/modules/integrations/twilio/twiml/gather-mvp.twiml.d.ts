export type TwilioSayBlockOption = {
    blockTwilioSay?: boolean;
};
export interface InboundGatherMvpTwiMLOptions extends TwilioSayBlockOption {
    gatherActionUrl: string;
    language?: string;
    speechTimeout?: string;
    timeoutSeconds?: number;
    pauseBeforeListenSeconds?: number;
    playbackAudioUrl?: string;
    finalFallbackAudioUrl?: string;
    openingSayText?: string;
    finalFallbackSayText?: string;
    includePromptInsideGather?: boolean;
}
export declare function buildInboundGatherMvpTwiML(options: InboundGatherMvpTwiMLOptions): string;
export declare function buildDeferredVoiceKickoffTwiML(options: {
    deferPollUrl: string;
    instantPlaybackUrl?: string;
    instantSayText?: string;
    allowTwilioSayFallback?: boolean;
    language?: string;
} & TwilioSayBlockOption): string;
export declare function buildDeferredVoicePollPauseTwiML(options: {
    deferPollUrl: string;
    pauseSeconds?: number;
}): string;
export declare function buildDeferredVoiceMomentPleaseTwiML(options: {
    deferPollUrl: string;
    playbackUrl?: string;
    sayFallbackText?: string;
    allowTwilioSayFallback?: boolean;
    language?: string;
} & TwilioSayBlockOption): string;
export declare function buildVoiceTerminalTwiml(options: {
    playbackAudioUrl?: string;
    sayText?: string;
    language?: string;
} & TwilioSayBlockOption): string;
export declare function escapeXml(text: string): string;
export declare function escapeXmlAttribute(value: string): string;
