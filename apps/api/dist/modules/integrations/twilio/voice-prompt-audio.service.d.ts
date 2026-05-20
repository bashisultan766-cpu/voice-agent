import { ElevenLabsService } from '../elevenlabs/elevenlabs.service';
import { TwilioTtsCacheService } from './twilio-tts-cache.service';
export declare class VoicePromptAudioService {
    private readonly elevenLabs;
    private readonly ttsCache;
    private readonly phraseBuffers;
    private readonly phraseTtlMs;
    constructor(elevenLabs: ElevenLabsService, ttsCache: TwilioTtsCacheService);
    private cacheKey;
    createPhrasePlaybackUrl(publicOrigin: string, opts: {
        text: string;
        voiceId: string;
        apiKey?: string;
        modelId?: string;
        styleNotes?: string;
    }): Promise<{
        playbackUrl?: string;
        fromPhraseCache: boolean;
    }>;
}
