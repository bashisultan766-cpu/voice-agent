export declare const VOICE_REPLY_TTS_MAX_CHARS = 120;
export declare const VOICE_TTS_MAX_AUDIO_BYTES: number;
export declare function shortenReplyForVoiceTts(original: string, maxChars?: number): {
    text: string;
    reply_shortened: boolean;
    originalChars: number;
    finalChars: number;
};
