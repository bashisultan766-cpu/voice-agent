import { OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentResolutionService } from './agent-resolution.service';
import { CallsService } from '../../calls/calls.service';
import { CallEventsService } from '../../analytics/call-events.service';
import { VoiceRuntimeService } from '../../calls/runtime/voice-runtime.service';
import { SessionContextService } from '../../calls/runtime/session-context.service';
import { TranscriptBufferService } from '../../calls/runtime/transcript-buffer.service';
import { ElevenLabsService } from '../elevenlabs/elevenlabs.service';
import { TwilioTtsCacheService } from './twilio-tts-cache.service';
import { PrismaService } from '../../../database/prisma.service';
import { EncryptionService } from '../../../common/encryption.service';
import { VoicePromptAudioService } from './voice-prompt-audio.service';
import { VoiceStreamMetricsService } from '../../calls/runtime/voice-stream-metrics.service';
import { VoiceCostAnalyticsService } from '../../calls/runtime/voice-cost-analytics.service';
import { VoiceStreamingSessionService } from '../../calls/runtime/voice-streaming-session.service';
import { ElevenLabsStreamingService } from '../elevenlabs/elevenlabs-streaming.service';
export interface InboundCallPayload {
    CallSid: string;
    From: string;
    To: string;
}
export interface InboundWebhookResult {
    twiml: string;
    callSessionId?: string;
    agentResolved: boolean;
}
export interface GatherMvpInboundPayload {
    CallSid: string;
    From: string;
    To: string;
    SpeechResult?: string;
    StableSpeechResult?: string;
    Confidence?: string;
    callSessionId?: string;
}
export interface GatherMvpWebhookResult {
    twiml: string;
    callSessionId?: string;
    agentResolved: boolean;
}
export interface DeferredPollInboundPayload {
    CallSid: string;
    From: string;
    To: string;
    callSessionId?: string;
}
export declare class TwilioWebhookService implements OnModuleInit {
    private readonly config;
    private readonly agentResolution;
    private readonly callsService;
    private readonly callEvents;
    private readonly voiceRuntime;
    private readonly sessionContext;
    private readonly transcriptBuffer;
    private readonly elevenLabs;
    private readonly ttsCache;
    private readonly voicePromptAudio;
    private readonly prisma;
    private readonly encryption;
    private readonly streamMetrics;
    private readonly voiceCost;
    private readonly streamingSession;
    private readonly elevenStreaming;
    private readonly logger;
    private readonly publicBaseUrl;
    constructor(config: ConfigService, agentResolution: AgentResolutionService, callsService: CallsService, callEvents: CallEventsService, voiceRuntime: VoiceRuntimeService, sessionContext: SessionContextService, transcriptBuffer: TranscriptBufferService, elevenLabs: ElevenLabsService, ttsCache: TwilioTtsCacheService, voicePromptAudio: VoicePromptAudioService, prisma: PrismaService, encryption: EncryptionService, streamMetrics: VoiceStreamMetricsService, voiceCost: VoiceCostAnalyticsService, streamingSession: VoiceStreamingSessionService, elevenStreaming: ElevenLabsStreamingService);
    onModuleInit(): void;
    private getPublicBaseUrl;
    private getVoiceGreetingMaxMs;
    private estimateGreetingAudioMs;
    private shortenGreetingForCapture;
    private isGatherHearingDebugMode;
    private isForceElevenLabsOnly;
    private isStrictElevenLabsOnly;
    private resolveGatherHearingDebugEffective;
    private resolveShortPhrasePlayUrl;
    private loadAgentWorkspaceFlags;
    private decryptAgentSecrets;
    private getWorkspaceIntegrationSlice;
    private auditOpenAiKeyForGather;
    private getSessionLanguage;
    handleInboundVoice(payload: InboundCallPayload): Promise<InboundWebhookResult>;
    handleGatherMvpVoice(payload: GatherMvpInboundPayload): Promise<GatherMvpWebhookResult>;
    handleDeferredVoicePoll(payload: DeferredPollInboundPayload): Promise<GatherMvpWebhookResult>;
    private logTwilioResponseMetrics;
    private kickDeferredVoiceProcessing;
    private failDeferredVoiceJobIfCurrent;
    private runDeferredVoiceJob;
    private executeDeferredVoiceJobBody;
    private resolveElevenLabsVoiceId;
    private withTimeout;
    private resolveElevenLabsApiKeyAndSource;
    private loadElevenLabsTtsOptions;
    private buildElevenLabsPlaybackUrl;
}
