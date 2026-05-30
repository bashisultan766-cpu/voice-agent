import { ElevenLabsService } from '../elevenlabs/elevenlabs.service';
import { TwilioTtsCacheService } from './twilio-tts-cache.service';
import { VoiceAudioCacheService } from './voice-audio-cache.service';
export declare const VOICE_PRODUCTION_PREWARM_PHRASES: readonly ["Hello! How can I help?", "Wa alaikum salam. How can I help?", "Sure, let me check.", "Sure, let me check that for you.", "Perfect. I'll help you place the order.", "Please tell me your email address.", "Please spell your email one character at a time.", "Your payment link has been sent successfully.", "You're welcome."];
export declare const VOICE_PRELOADED_PHRASES: readonly ["Hello! How can I help?", "Wa alaikum salam. How can I help?", "Sure, let me check.", "Sure, let me check that for you.", "Perfect. I'll help you place the order.", "Please tell me your email address.", "Please spell your email one character at a time.", "Your payment link has been sent successfully.", "You're welcome.", "Wa alaikum salam. How can I help you today?", "I'm doing great, thank you.", "Great. What would you like next?", "No problem. What can I help with?", "Sounds good. How can I help?", "Goodbye. Have a great day.", "Namaste. How can I help you today?", "Got it — checking that title instead.", "Just to confirm, is that email correct?", "You're welcome. Thank you for your order.", "Of course. What would you like me to repeat?", "Sure, I'll speak in English. How can I help?", "One moment...", "Checking that for you...", "Let me verify...", "One moment while I check that for you.", "Looking that up for you now.", "Checking similar titles in our catalog.", "Let me pull that up for you.", "Searching our shelves for that title.", "One moment please.", "Just a second."];
type CacheLayer = 'memory' | 'redis' | 'disk' | 'miss';
export declare class VoicePromptAudioService {
    private readonly elevenLabs;
    private readonly ttsCache;
    private readonly audioCache;
    private readonly logger;
    private readonly phraseBuffers;
    private readonly phraseTtlMs;
    constructor(elevenLabs: ElevenLabsService, ttsCache: TwilioTtsCacheService, audioCache: VoiceAudioCacheService);
    audioCacheKey(voiceId: string, modelId: string, text: string): string;
    hasCachedPhrase(voiceId: string, modelId: string, text: string): boolean;
    resolveLatencyModelId(_agentModelId?: string | null): string;
    warmPreloadedPhrases(opts: {
        voiceId: string;
        apiKey?: string;
    }): Promise<{
        warmed: number;
        modelId: string;
    }>;
    private ensurePhraseBuffer;
    private cacheKey;
    resolveCachedPhrasePlaybackUrl(publicOrigin: string, opts: {
        text: string;
        voiceId: string;
        modelId?: string;
        callSessionId?: string;
    }): Promise<{
        playbackUrl?: string;
        fromPhraseCache: boolean;
        audioCacheKey: string;
        ttsGenerated: boolean;
        audioServedFromCache: boolean;
        audioCacheHit: boolean;
        cacheLayer: CacheLayer;
    }>;
    createPhrasePlaybackUrl(publicOrigin: string, opts: {
        text: string;
        voiceId: string;
        apiKey?: string;
        modelId?: string;
        callSessionId?: string;
        cacheOnly?: boolean;
    }): Promise<{
        playbackUrl?: string;
        fromPhraseCache: boolean;
        audioCacheKey: string;
        ttsGenerated: boolean;
        elevenlabsLatencyMs?: number;
        elevenlabsModel?: string;
        audioServedFromCache?: boolean;
        audioCacheHit?: boolean;
        ttsLatencyMs?: number;
    }>;
    private getMemoryBuffer;
    private bufferToPlayback;
    private logAudioCache;
    logWarmComplete(args: {
        agents: number;
        phrases: number;
        modelId: string;
    }): void;
}
export {};
