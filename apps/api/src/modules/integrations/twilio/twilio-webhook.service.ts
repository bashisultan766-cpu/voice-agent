import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { AgentResolutionService, type ResolvedAgentContext } from './agent-resolution.service';
import { CallsService } from '../../calls/calls.service';
import { CallEventsService } from '../../analytics/call-events.service';
import { CallEventType, CallStatus } from '@prisma/client';
import { buildFallbackTwiML } from './twiml/conversation-relay.twiml';
import {
  buildDeferredVoiceKickoffTwiML,
  buildDeferredVoiceMomentPleaseTwiML,
  buildDeferredVoicePollPauseTwiML,
  buildInboundGatherMvpTwiML,
  buildVoiceTerminalTwiml,
} from './twiml/gather-mvp.twiml';
import { VoiceRuntimeService } from '../../calls/runtime/voice-runtime.service';
import { SessionContextService } from '../../calls/runtime/session-context.service';
import { TranscriptBufferService } from '../../calls/runtime/transcript-buffer.service';
import { ElevenLabsService } from '../elevenlabs/elevenlabs.service';
import { TwilioTtsCacheService } from './twilio-tts-cache.service';
import { validatePublicWebhookBaseUrl } from '../../../common/public-webhook-base-url';
import { normalizeLanguageForTwilio } from '../../calls/runtime/language-intelligence.util';
import { normalizePhoneNumber } from './utils/normalize-phone';
import { PrismaService } from '../../../database/prisma.service';
import { EncryptionService } from '../../../common/encryption.service';
import { buildCredentialSourcesSummary, type AgentSecretsSlice, type WorkspaceIntegrationSlice } from '../../../common/credential-resolver.util';
import {
  openAiKeyLayerPresence,
  resolveElevenLabsKeyChain,
  resolveOpenAiKeyChain,
  type VoiceCredentialSource,
} from '../../calls/runtime/voice-config-resolution.util';
import { fingerprintApiKey } from '../../../common/logging/api-key-fingerprint';
import { gatedProcessEnv } from '../../../common/provider-env-slice.util';
import {
  buildTtsPlaybackUrl,
  prepareVoiceTtsInputText,
  validateTtsAudioBuffer,
} from './voice-elevenlabs-playback.util';
import { VoicePromptAudioService } from './voice-prompt-audio.service';
import { classifyUserIntent } from '../../calls/runtime/user-intent-classifier.util';
import { buildInstantAckMetadataPatch, selectInstantAcknowledgement } from './instant-acknowledgement.util';
import { buildInstantReply } from '../../calls/runtime/instant-reply.util';
import {
  logVoiceLatencyBreakdown,
  VoiceLatencyTimer,
} from '../../calls/runtime/voice-latency-breakdown.util';
import {
  isVoiceCommerceFastMode,
  voiceDeferredPollPauseSeconds,
  voiceSearchFillerThresholdMs,
} from '../../calls/runtime/voice-commerce-fast-mode.util';
import { pickVoiceSearchFillerPhrase } from '../../search/voice/voice-search-filler.util';
import {
  assertNoTwilioSayInTwiml,
  buildElevenLabsOnlyModeActiveLog,
  buildTwilioSayBlockedLog,
  buildVoiceProviderEnforcedLog,
  resolvePlaybackChannel,
  resolvePlaybackLogKind,
  resolveVoiceProviderActuallyUsed,
  resolveVoiceProviderPolicy,
  shouldPlayDeferredSearchFiller,
  type VoiceProviderActuallyUsed,
  type VoiceProviderPolicy,
} from './voice-provider-policy.util';
import type { UserUtteranceIntent } from '../../calls/runtime/user-intent-classifier.util';
import {
  buildMediaStreamConnectTwiML,
  isMediaStreamInboundEnabled,
} from './twiml/media-stream.twiml';
import { VoiceStreamMetricsService } from '../../calls/runtime/voice-stream-metrics.service';
import { VoiceCostAnalyticsService } from '../../calls/runtime/voice-cost-analytics.service';
import { VoiceStreamingSessionService } from '../../calls/runtime/voice-streaming-session.service';
import { ElevenLabsStreamingService } from '../elevenlabs/elevenlabs-streaming.service';
import { stallAcknowledgement } from '../../calls/runtime/streaming-fallback.util';
import {
  buildLlmReplyMetadataPatch,
  shouldBlockNonOrchestratorTts,
} from '../../calls/runtime/voice-single-reply-pipeline.util';
import {
  resolveInboundGreetingText,
  shouldPlayInboundElevenLabsGreeting,
} from '../../calls/runtime/book-sales-voice.util';
import { computeGatherSpeechGate } from './gather-speech-gate.util';
import { resolveGatherTwiMLOptions } from '../../calls/runtime/telephony-spelling-capture.util';

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
  /** Some Twilio regions / configs send stable transcript in this field. */
  StableSpeechResult?: string;
  Confidence?: string;
  /**
   * Provided via the Gather action URL query string.
   * Step 3 reads this first, but falls back to looking up by `CallSid`.
   */
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

type DeferredVoiceJobMetadata =
  | {
      jobId: string;
      phase: 'processing';
      startedAtMs: number;
      momentPromptPlayed: boolean;
    }
  | {
      jobId: string;
      phase: 'ready';
      startedAtMs: number;
      momentPromptPlayed: boolean;
      assistantResponse: string;
      playbackUrl?: string;
      usedElevenLabs: boolean;
      audioBytes?: number;
      ttsGenerationTimeMs: number;
      firstChunkPlaybackUrl?: string;
      streamingEnabled?: boolean;
    }
  | {
      jobId: string;
      phase: 'failed';
      startedAtMs: number;
      errorMessage: string;
    };

function maskPhoneForLog(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `****${digits.slice(-4)}`;
}

/** Minimum time for background OpenAI + Shopify + ElevenLabs; below this causes false timeouts (e.g. EL alone often 8–15s). */
const VOICE_DEFERRED_JOB_TIMEOUT_MS_MIN = 50_000;

@Injectable()
export class TwilioWebhookService implements OnModuleInit {
  private readonly logger = new Logger(TwilioWebhookService.name);
  private readonly publicBaseUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly agentResolution: AgentResolutionService,
    private readonly callsService: CallsService,
    private readonly callEvents: CallEventsService,
    private readonly voiceRuntime: VoiceRuntimeService,
    private readonly sessionContext: SessionContextService,
    private readonly transcriptBuffer: TranscriptBufferService,
    private readonly elevenLabs: ElevenLabsService,
    private readonly ttsCache: TwilioTtsCacheService,
    private readonly voicePromptAudio: VoicePromptAudioService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly streamMetrics: VoiceStreamMetricsService,
    private readonly voiceCost: VoiceCostAnalyticsService,
    private readonly streamingSession: VoiceStreamingSessionService,
    private readonly elevenStreaming: ElevenLabsStreamingService,
  ) {
    const validated = validatePublicWebhookBaseUrl(this.config.get<string>('PUBLIC_WEBHOOK_BASE_URL'));
    if (!validated.ok) {
      const reason = validated.reason ?? 'invalid';
      throw new Error(
        `Invalid PUBLIC_WEBHOOK_BASE_URL (${reason}). Set a public HTTPS origin (no localhost/ngrok/example/localtunnel).`,
      );
    }
    this.publicBaseUrl = validated.normalized;
  }

  onModuleInit(): void {
    const gatherDebug = this.isGatherHearingDebugMode();
    const forceEl = this.isForceElevenLabsOnly();
    if (gatherDebug) {
      this.logger.warn(
        JSON.stringify({
          event: 'twilio.voice.config_warning',
          TWILIO_GATHER_HEARING_DEBUG: true,
          FORCE_ELEVENLABS_ONLY: forceEl,
          effect: forceEl
            ? 'TWILIO_GATHER_HEARING_DEBUG is set, but FORCE_ELEVENLABS_ONLY wins: short scripted prompts still use ElevenLabs <Play> (Twilio <Say> is only used if ElevenLabs fails, voice ID is missing, or PUBLIC_WEBHOOK_BASE_URL is not HTTPS).'
            : 'TWILIO_GATHER_HEARING_DEBUG disables ElevenLabs for short scripted prompts; those lines use Twilio <Say> instead. This helps STT debugging but sounds like a second voice in production—unset it or set FORCE_ELEVENLABS_ONLY=true to keep ElevenLabs.',
        }),
      );
    }
    this.logger.log(
      JSON.stringify({
        event: 'voice.public_base_url',
        value: this.publicBaseUrl,
      }),
    );
    const policy = this.voiceProviderPolicy();
    if (policy.twilioSayBlocked) {
      this.logger.log(JSON.stringify(buildElevenLabsOnlyModeActiveLog(policy)));
    }
    void this.warmPhraseAudioAtStartup().catch((err) => {
      this.logger.warn(
        `Phrase audio warm skipped: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`,
      );
    });
  }

  private async warmPhraseAudioAtStartup(): Promise<void> {
    const apiKey = this.config.get<string>('ELEVENLABS_API_KEY')?.trim();
    const agents = await this.prisma.agent.findMany({
      where: { status: 'ACTIVE', voiceId: { not: null }, deletedAt: null },
      select: { voiceId: true },
      take: 12,
      orderBy: { updatedAt: 'desc' },
    });
    for (const agent of agents) {
      const voiceId = agent.voiceId?.trim();
      if (!voiceId) continue;
      this.voicePromptAudio.warmPreloadedPhrases({
        voiceId,
        apiKey: apiKey || undefined,
      });
    }
    this.logger.log(
      JSON.stringify({
        event: 'voice.startup_phrase_audio_warm',
        agents: agents.length,
      }),
    );
  }

  private getPublicBaseUrl(): string {
    return this.publicBaseUrl;
  }

  private getVoiceGreetingMaxMs(): number {
    const raw = `${this.config.get<string>('VOICE_GREETING_MAX_MS') ?? process.env.VOICE_GREETING_MAX_MS ?? '1200'}`.trim();
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 1200;
    return Math.max(400, Math.min(3000, Math.trunc(n)));
  }

  private estimateGreetingAudioMs(text: string): number {
    const chars = text.trim().length;
    if (chars <= 0) return 0;
    return Math.max(350, Math.min(7000, Math.trunc(chars * 55)));
  }

  private shortenGreetingForCapture(text: string, maxMs: number): string {
    const t = text.trim();
    if (!t) return "I'm still here. How can I help you with your book order?";
    if (this.estimateGreetingAudioMs(t) <= maxMs) return t;
    const sentence = t.split(/[.!?]/).map((s) => s.trim()).filter(Boolean)[0] ?? t;
    const compact = sentence.split(/\s+/).slice(0, 8).join(' ');
    return compact.length > 0 ? compact : "I'm still here. How can I help you with your book order?";
  }

  private isGatherHearingDebugMode(): boolean {
    const v = `${this.config.get<string>('TWILIO_GATHER_HEARING_DEBUG') ?? process.env.TWILIO_GATHER_HEARING_DEBUG ?? ''}`.trim();
    return v === '1' || v.toLowerCase() === 'true';
  }

  private isForceElevenLabsOnly(): boolean {
    return this.voiceProviderPolicy().forceElevenLabsOnly;
  }

  private isForceTwilioFallback(): boolean {
    return this.voiceProviderPolicy().forceTwilioFallback;
  }

  /**
   * Hard lock to ElevenLabs playback only.
   * Default is enabled to prevent Twilio <Say> voice drift.
   */
  private isStrictElevenLabsOnly(): boolean {
    return this.voiceProviderPolicy().twilioSayBlocked;
  }

  private voiceProviderPolicy(): VoiceProviderPolicy {
    return resolveVoiceProviderPolicy({
      FORCE_ELEVENLABS_ONLY:
        this.config.get<string>('FORCE_ELEVENLABS_ONLY') ?? process.env.FORCE_ELEVENLABS_ONLY,
      STRICT_ELEVENLABS_ONLY:
        this.config.get<string>('STRICT_ELEVENLABS_ONLY') ?? process.env.STRICT_ELEVENLABS_ONLY,
      FORCE_TWILIO_FALLBACK:
        this.config.get<string>('FORCE_TWILIO_FALLBACK') ?? process.env.FORCE_TWILIO_FALLBACK,
    });
  }

  private logVoiceProviderEnforced(callSessionId: string, route: string): void {
    const policy = this.voiceProviderPolicy();
    if (!policy.twilioSayBlocked) return;
    this.logger.log(
      JSON.stringify({
        ...buildVoiceProviderEnforcedLog(policy),
        callSessionId,
        route,
      }),
    );
  }

  /** When true, short prompts use Twilio Say unless ElevenLabs-only policy overrides. */
  private resolveGatherHearingDebugEffective(): boolean {
    if (this.voiceProviderPolicy().twilioSayBlocked) return false;
    return this.isGatherHearingDebugMode();
  }

  private allowTwilioSayFallback(): boolean {
    return !this.voiceProviderPolicy().disableTwilioSayCompletely;
  }

  private blockTwilioSay(): boolean {
    return this.voiceProviderPolicy().twilioSayBlocked;
  }

  private finalizeTwiml(twiml: string, route: string): string {
    const policy = this.voiceProviderPolicy();
    try {
      assertNoTwilioSayInTwiml(twiml, policy);
    } catch (err) {
      this.logger.error(
        JSON.stringify({
          ...buildTwilioSayBlockedLog({
            route,
            reason: err instanceof Error ? err.message : 'twilio_say_in_twiml',
          }),
        }),
      );
      throw err;
    }
    return twiml;
  }

  private voicePlaybackFields(hasPlayback: boolean): {
    voiceProviderActuallyUsed: VoiceProviderActuallyUsed;
    playback: ReturnType<typeof resolvePlaybackLogKind>;
    playbackChannel: ReturnType<typeof resolvePlaybackChannel>;
  } {
    const policy = this.voiceProviderPolicy();
    return {
      voiceProviderActuallyUsed: resolveVoiceProviderActuallyUsed(hasPlayback, policy),
      playback: resolvePlaybackLogKind(hasPlayback, policy),
      playbackChannel: resolvePlaybackChannel(hasPlayback, policy),
    };
  }

  private logTwilioSayWouldHaveBeenUsed(route: string, reason: string): void {
    if (!this.blockTwilioSay()) return;
    this.logger.warn(
      JSON.stringify({
        ...buildTwilioSayBlockedLog({ route, reason }),
      }),
    );
  }

  /**
   * Short scripted prompts: ElevenLabs via phrase cache when TWILIO_GATHER_HEARING_DEBUG is off; Twilio Say when debug or EL fails.
   */
  private logHiddenReplyDetected(entry: {
    callSessionId: string;
    text: string;
    sourceFunction: string;
    reason: string;
  }): void {
    this.logger.warn(
      JSON.stringify({
        event: 'voice.hidden_reply_detected',
        callSessionId: entry.callSessionId,
        text: entry.text.slice(0, 200),
        sourceFunction: entry.sourceFunction,
        originalChars: entry.text.length,
        reason: entry.reason,
      }),
    );
  }

  private async resolveShortPhrasePlayUrl(params: {
    origin: string;
    hearingDebugEffective: boolean;
    text: string;
    tenantId: string;
    callSessionId: string;
    agent: {
      voiceProvider?: string | null;
      voiceId?: string | null;
      elevenlabsApiKey?: string | null;
      elevenlabsModel?: string | null;
    };
    logLabel: string;
    allowWhenLlmReplyActive?: boolean;
  }): Promise<{ playbackUrl?: string; voiceProviderActuallyUsed: VoiceProviderActuallyUsed }> {
    const policy = this.voiceProviderPolicy();
    const blockTwilioSay = policy.disableTwilioSayCompletely;

    const sessionRow = await this.callsService.findOneById(params.callSessionId);
    const sessionMeta =
      sessionRow.metadata && typeof sessionRow.metadata === 'object' && !Array.isArray(sessionRow.metadata)
        ? (sessionRow.metadata as Record<string, unknown>)
        : {};
    const blocked = shouldBlockNonOrchestratorTts({
      metadata: sessionMeta,
      candidateText: params.text,
      sourceFunction: params.logLabel,
      allowEmptySpeechRetry: params.allowWhenLlmReplyActive,
    });
    if (blocked) {
      this.logHiddenReplyDetected({
        callSessionId: params.callSessionId,
        text: blocked.text,
        sourceFunction: blocked.sourceFunction,
        reason: blocked.reason,
      });
      return {
        voiceProviderActuallyUsed: resolveVoiceProviderActuallyUsed(false, policy),
      };
    }

    const voiceId = this.resolveElevenLabsVoiceId(params.agent);
    const voiceProviderRequested = 'elevenlabs';
    const forceElOnly = policy.forceElevenLabsOnly;
    const strictElOnly = blockTwilioSay;

    if (params.hearingDebugEffective && strictElOnly) {
      this.logger.warn(
        JSON.stringify({
          event: 'voice.strict_elevenlabs_only',
          callSessionId: params.callSessionId,
          phrase: params.logLabel,
          message: 'Twilio Say disabled; using ElevenLabs agent voice ID only.',
        }),
      );
    }

    if (params.hearingDebugEffective && !strictElOnly) {
      this.logger.warn(
        JSON.stringify({
          event: 'twilio.voice.phrase_audio',
          callSessionId: params.callSessionId,
          tenantId: params.tenantId,
          phrase: params.logLabel,
          voiceProviderRequested,
          voiceIdUsed: voiceId ?? null,
          voiceProviderActuallyUsed: 'twilio_say_fallback',
          twimlVerbUsed: 'Say',
          voiceFallbackToTwilioSay: true,
          fallbackReason: 'twilio_gather_hearing_debug',
          emergencyTwilioSayFallback: forceElOnly,
        }),
      );
      return { voiceProviderActuallyUsed: 'twilio_say_fallback' };
    }
    if (params.hearingDebugEffective && strictElOnly) {
      this.logTwilioSayWouldHaveBeenUsed(params.logLabel, 'twilio_gather_hearing_debug_blocked');
    }
    if (!voiceId || !/^https:\/\//i.test(params.origin)) {
      this.logger.warn(
        JSON.stringify({
          event: 'twilio.voice.phrase_audio',
          callSessionId: params.callSessionId,
          phrase: params.logLabel,
          voiceProviderRequested,
          voiceIdUsed: voiceId ?? null,
          voiceProviderActuallyUsed: resolveVoiceProviderActuallyUsed(false, policy),
          twimlVerbUsed: strictElOnly ? 'silent' : 'Say',
          voiceFallbackToTwilioSay: !strictElOnly,
          fallbackReason: !voiceId ? 'no_elevenlabs_voice_id' : 'webhook_base_not_https',
          strictElevenLabsOnly: strictElOnly,
          twilioSayBlocked: blockTwilioSay,
        }),
      );
      if (strictElOnly) {
        this.logTwilioSayWouldHaveBeenUsed(params.logLabel, !voiceId ? 'no_elevenlabs_voice_id' : 'webhook_base_not_https');
      }
      return strictElOnly
        ? { playbackUrl: undefined, voiceProviderActuallyUsed: 'elevenlabs_silent_wait' }
        : { voiceProviderActuallyUsed: 'twilio_say_fallback' };
    }

    const phraseOpts = {
      text: params.text,
      voiceId,
      apiKey: params.agent.elevenlabsApiKey ?? undefined,
      modelId: params.agent.elevenlabsModel ?? undefined,
    };
    let r = await this.voicePromptAudio.createPhrasePlaybackUrl(params.origin, phraseOpts);
    if (!r.playbackUrl && blockTwilioSay) {
      r = await this.voicePromptAudio.createPhrasePlaybackUrl(params.origin, phraseOpts);
    }
    if (!r.playbackUrl) {
      this.logger.warn(
        JSON.stringify({
          event: 'twilio.voice.phrase_audio',
          callSessionId: params.callSessionId,
          phrase: params.logLabel,
          voiceProviderRequested,
          voiceIdUsed: voiceId,
          voiceProviderActuallyUsed: resolveVoiceProviderActuallyUsed(false, policy),
          twimlVerbUsed: strictElOnly ? 'silent' : 'Say',
          voiceFallbackToTwilioSay: !strictElOnly,
          fallbackReason: 'elevenlabs_phrase_failed',
          strictElevenLabsOnly: strictElOnly,
          twilioSayBlocked: blockTwilioSay,
        }),
      );
      if (strictElOnly) {
        this.logTwilioSayWouldHaveBeenUsed(params.logLabel, 'elevenlabs_phrase_failed');
      }
      return strictElOnly
        ? { playbackUrl: undefined, voiceProviderActuallyUsed: 'elevenlabs_silent_wait' }
        : { voiceProviderActuallyUsed: 'twilio_say_fallback' };
    }
    this.logger.log(
      JSON.stringify({
        event: 'twilio.voice.phrase_audio',
        callSessionId: params.callSessionId,
        phrase: params.logLabel,
        voiceProviderRequested,
        voiceIdUsed: voiceId,
        voiceProviderActuallyUsed: 'elevenlabs',
        twimlVerbUsed: 'Play',
        fromPhraseCache: r.fromPhraseCache,
      }),
    );
    return { playbackUrl: r.playbackUrl, voiceProviderActuallyUsed: 'elevenlabs' };
  }

  private async loadAgentWorkspaceFlags(agentId: string | undefined): Promise<{
    useWorkspaceOpenai: boolean;
    useWorkspaceElevenlabs: boolean;
  }> {
    if (!agentId) {
      return { useWorkspaceOpenai: false, useWorkspaceElevenlabs: false };
    }
    const cfg = await this.prisma.agentConfig.findUnique({
      where: { agentId },
      select: { useWorkspaceOpenai: true, useWorkspaceElevenlabs: true },
    });
    return {
      useWorkspaceOpenai: cfg?.useWorkspaceOpenai === true,
      useWorkspaceElevenlabs: cfg?.useWorkspaceElevenlabs === true,
    };
  }

  private decryptAgentSecrets(secretsEnc: string | null | undefined): AgentSecretsSlice {
    if (!secretsEnc || !this.encryption.isAvailable()) return {};
    const dec = this.encryption.decryptFromStorage(secretsEnc);
    if (!dec) return {};
    try {
      return JSON.parse(dec) as AgentSecretsSlice;
    } catch {
      return {};
    }
  }

  private async getWorkspaceIntegrationSlice(tenantId: string): Promise<WorkspaceIntegrationSlice | null> {
    const row = await this.prisma.tenantIntegration.findUnique({
      where: { tenantId },
      select: {
        shopifyShopDomain: true,
        shopifyAdminTokenEnc: true,
        openaiApiKeyEnc: true,
        elevenlabsApiKeyEnc: true,
        elevenlabsDefaultVoiceId: true,
        twilioAccountSid: true,
        twilioAuthTokenEnc: true,
        twilioPhoneNumber: true,
        resendApiKeyEnc: true,
      },
    });
    if (!row || !this.encryption.isAvailable()) return null;
    return {
      shopifyStoreUrl: row.shopifyShopDomain?.trim()
        ? `https://${row.shopifyShopDomain.trim()}`
        : undefined,
      shopifyAdminToken: row.shopifyAdminTokenEnc
        ? (this.encryption.decryptFromStorage(row.shopifyAdminTokenEnc) ?? undefined)
        : undefined,
      openaiApiKey: row.openaiApiKeyEnc
        ? (this.encryption.decryptFromStorage(row.openaiApiKeyEnc) ?? undefined)
        : undefined,
      elevenlabsApiKey: row.elevenlabsApiKeyEnc
        ? (this.encryption.decryptFromStorage(row.elevenlabsApiKeyEnc) ?? undefined)
        : undefined,
      elevenlabsDefaultVoiceId: row.elevenlabsDefaultVoiceId?.trim() || undefined,
      twilioAccountSid: row.twilioAccountSid?.trim() || undefined,
      twilioAuthToken: row.twilioAuthTokenEnc
        ? (this.encryption.decryptFromStorage(row.twilioAuthTokenEnc) ?? undefined)
        : undefined,
      twilioPhoneNumber: row.twilioPhoneNumber?.trim() || undefined,
      resendApiKey: row.resendApiKeyEnc
        ? (this.encryption.decryptFromStorage(row.resendApiKeyEnc) ?? undefined)
        : undefined,
    };
  }

  /**
   * OpenAI key resolution for gather-turn logs + parity with GET /api/voice/config-check.
   */
  private async auditOpenAiKeyForGather(
    tenantId: string,
    secretsEnc: string | null | undefined,
    agentId?: string,
  ): Promise<{
    openaiKeySource: VoiceCredentialSource;
    openaiKeyFingerprint: string | null;
    agentKeyPresent: boolean;
    tenantKeyPresent: boolean;
    envKeyPresent: boolean;
    agentOverridesWorkspaceOpenai: boolean;
  }> {
    let agentOpenaiPlain: string | null = null;
    if (secretsEnc && this.encryption.isAvailable()) {
      const dec = this.encryption.decryptFromStorage(secretsEnc);
      if (dec) {
        try {
          const secrets = JSON.parse(dec) as { openaiApiKey?: string };
          agentOpenaiPlain = typeof secrets.openaiApiKey === 'string' ? secrets.openaiApiKey : null;
        } catch {
          /* ignore */
        }
      }
    }

    const ti = this.encryption.isAvailable()
      ? await this.prisma.tenantIntegration.findUnique({
          where: { tenantId },
          select: { openaiApiKeyEnc: true },
        })
      : null;

    const encAvail = this.encryption.isAvailable();
    const workspaceFlags = await this.loadAgentWorkspaceFlags(agentId);
    const envPlain = gatedProcessEnv('OPENAI_API_KEY', this.config);
    const openaiR = resolveOpenAiKeyChain({
      agentSecretPlain: agentOpenaiPlain,
      tenantEnc: ti?.openaiApiKeyEnc ?? null,
      decryptFromStorage: (s) => this.encryption.decryptFromStorage(s),
      envPlain,
      encryptionAvailable: encAvail,
      useWorkspaceOpenai: workspaceFlags.useWorkspaceOpenai,
    });

    const layers = openAiKeyLayerPresence({
      agentSecretPlain: agentOpenaiPlain,
      tenantEnc: ti?.openaiApiKeyEnc ?? null,
      envPlain,
      useWorkspaceOpenai: workspaceFlags.useWorkspaceOpenai,
    });

    return {
      openaiKeySource: openaiR.source,
      openaiKeyFingerprint: fingerprintApiKey(openaiR.value),
      agentKeyPresent: layers.agentKeyPresent,
      tenantKeyPresent: layers.tenantKeyPresent,
      envKeyPresent: layers.envKeyPresent,
      agentOverridesWorkspaceOpenai: layers.agentKeyPresent && layers.tenantKeyPresent,
    };
  }

  private getSessionLanguage(ctx: Awaited<ReturnType<SessionContextService['load']>>): string {
    const metadataLanguage =
      typeof ctx?.metadata?.language === 'string' ? ctx.metadata.language.trim().toLowerCase() : '';
    if (metadataLanguage) return normalizeLanguageForTwilio(metadataLanguage);
    return normalizeLanguageForTwilio(ctx?.agent.language ?? 'en');
  }

  async handleInboundVoice(payload: InboundCallPayload): Promise<InboundWebhookResult> {
    const normalizedTo = normalizePhoneNumber(payload.To);
    this.logger.log(
      JSON.stringify({
        event: 'twilio.voice.inbound_received',
        callSid: payload.CallSid,
        from: maskPhoneForLog(payload.From),
        to: maskPhoneForLog(payload.To),
        toNormalizedLast4: normalizedTo.replace(/\D/g, '').slice(-4),
      }),
    );

    const context = await this.agentResolution.resolveByPhoneNumber(payload.To);
    if (!context) {
      this.logger.warn(
        JSON.stringify({
          event: 'twilio.voice.agent_not_resolved',
          callSid: payload.CallSid,
          to: maskPhoneForLog(payload.To),
          toNormalizedLast4: normalizedTo.replace(/\D/g, '').slice(-4),
          mappingFound: false,
        }),
      );
      const fallbackPlayback = this.voicePlaybackFields(false);
      const twiml = this.finalizeTwiml(
        buildFallbackTwiML(undefined, { blockTwilioSay: this.blockTwilioSay() }),
        'inbound_agent_not_resolved',
      );
      this.logger.log(
        JSON.stringify({
          event: 'twilio.voice.twiml_returned',
          route: 'inbound',
          agentResolved: false,
          twimlChars: twiml.length,
          playback: fallbackPlayback.playback,
          ttsFallbackUsed: !this.blockTwilioSay(),
          playbackChannel: fallbackPlayback.playbackChannel,
          voiceProviderActuallyUsed: fallbackPlayback.voiceProviderActuallyUsed,
        }),
      );
      return { twiml, agentResolved: false };
    }

    this.logger.log(
      JSON.stringify({
        event: 'twilio.voice.agent_resolved',
        callSid: payload.CallSid,
        agentId: context.agentId,
        tenantId: context.tenantId,
        storeId: context.storeId,
        phoneNumberId: context.phoneNumberId,
        to: maskPhoneForLog(payload.To),
        toNormalizedLast4: normalizedTo.replace(/\D/g, '').slice(-4),
        mappingFound: true,
      }),
    );

    const session = await this.callsService.createSession({
      tenantId: context.tenantId,
      storeId: context.storeId,
      agentId: context.agentId,
      phoneNumberId: context.phoneNumberId,
      twilioCallSid: payload.CallSid,
      fromNumber: payload.From,
      toNumber: payload.To,
      direction: 'inbound',
    });

    await this.callEvents.log(context.tenantId, session.id, CallEventType.INBOUND_CALL_RECEIVED, {
      from: payload.From,
      to: payload.To,
      twilioCallSid: payload.CallSid,
    });
    await this.callEvents.log(context.tenantId, session.id, CallEventType.CALL_SESSION_CREATED, {
      agentId: context.agentId,
      storeId: context.storeId,
    });

    await this.callEvents.log(context.tenantId, session.id, CallEventType.AGENT_RESOLVED, {
      agentId: context.agentId,
      to: payload.To,
    });
    console.log('[voice-runtime] loaded agent', context.agentId, context.agent.name);
    const agentRow = await this.prisma.agent.findFirst({
      where: { id: context.agentId, tenantId: context.tenantId, deletedAt: null },
      select: { updatedAt: true },
    });
    console.log('[voice-runtime] using prompt version', agentRow?.updatedAt?.toISOString() ?? 'unknown');

    this.logger.log(
      JSON.stringify({
        event: 'voice.journey.call_session_created',
        callSessionId: session.id,
        tenantId: context.tenantId,
        agentId: context.agentId,
        agentName: context.agent.name,
        storeId: context.storeId,
        twilioCallSid: payload.CallSid,
        configUpdatedAt: agentRow?.updatedAt?.toISOString() ?? null,
      }),
    );

    const runtimeAgentRow = await this.prisma.agent.findFirst({
      where: { id: context.agentId, tenantId: context.tenantId, deletedAt: null },
      select: {
        status: true,
        shopifyStoreUrl: true,
        voiceId: true,
        secretsEnc: true,
        agentConfig: {
          select: {
            useWorkspaceShopify: true,
            useWorkspaceOpenai: true,
            useWorkspaceElevenlabs: true,
            useWorkspaceTwilio: true,
            useWorkspaceEmail: true,
          },
        },
      },
    });
    if (runtimeAgentRow) {
      const [workspaceSlice, sessionCtx] = await Promise.all([
        this.getWorkspaceIntegrationSlice(context.tenantId),
        this.sessionContext.load(session.id),
      ]);
      const sources = buildCredentialSourcesSummary({
        agent: {
          shopifyStoreUrl: runtimeAgentRow.shopifyStoreUrl,
          voiceId: runtimeAgentRow.voiceId,
          secrets: this.decryptAgentSecrets(runtimeAgentRow.secretsEnc),
          useWorkspaceShopify: runtimeAgentRow.agentConfig?.useWorkspaceShopify === true,
          useWorkspaceOpenai: runtimeAgentRow.agentConfig?.useWorkspaceOpenai === true,
          useWorkspaceElevenlabs: runtimeAgentRow.agentConfig?.useWorkspaceElevenlabs === true,
          useWorkspaceTwilio: runtimeAgentRow.agentConfig?.useWorkspaceTwilio === true,
          useWorkspaceEmail: runtimeAgentRow.agentConfig?.useWorkspaceEmail === true,
        },
        workspace: workspaceSlice,
      });
      const missingRequirements = [
        !sources.openai.configured ? 'openai' : null,
        !sources.twilio.configured ? 'twilio' : null,
        !sources.elevenlabs.configured && (sessionCtx?.agent.voiceProvider ?? '').toLowerCase() === 'elevenlabs'
          ? 'elevenlabs'
          : null,
        !sources.resend.configured ? 'resend' : null,
      ].filter((v): v is string => Boolean(v));
      this.logger.log(
        JSON.stringify({
          event: 'voice.runtime.readiness.summary',
          callSessionId: session.id,
          agentId: context.agentId,
          tenantId: context.tenantId,
          agentStatus: runtimeAgentRow.status,
          openaiSource: sources.openai.source,
          twilioSource: sources.twilio.authSource,
          elevenlabsSource: sources.elevenlabs.source,
          resendSource: sources.resend.source,
          missingRequirements,
        }),
      );
    }

    const origin = this.getPublicBaseUrl();

    if (isMediaStreamInboundEnabled()) {
      const wsBase = origin.replace(/^http/i, 'wss');
      const streamUrl = `${wsBase}/api/twilio/voice/media-stream?callSessionId=${encodeURIComponent(session.id)}`;
      const twimlStream = buildMediaStreamConnectTwiML(streamUrl, session.id);
      await this.streamMetrics.merge(session.id, {
        streamingMode: 'media_stream',
        streamingStatus: 'listening',
      });
      this.logger.log(
        JSON.stringify({
          event: 'twilio.voice.inbound_media_stream',
          callSessionId: session.id,
        }),
      );
      return { twiml: twimlStream, callSessionId: session.id, agentResolved: true };
    }

    const gatherActionUrl = `${origin}/api/twilio/voice/gather?callSessionId=${encodeURIComponent(
      session.id,
    )}`;

    const hearingDebug = this.isGatherHearingDebugMode();
    const hearingDebugEffective = this.resolveGatherHearingDebugEffective();
    const forceElOnly = this.isForceElevenLabsOnly();
    const strictElevenLabsOnly = this.isStrictElevenLabsOnly();
    const debugOpeningText = 'Please say your question after the beep.';
    const elOptsInbound = await this.loadElevenLabsTtsOptions(context);
    const inboundGreetingText = resolveInboundGreetingText(context.agent.greetingMessage);
    const estimatedGreetingMs = this.estimateGreetingAudioMs(inboundGreetingText);
    const fallbackText =
      context.agent.fallbackMessage?.trim() ??
      "We're having trouble hearing you. Please call again later. Goodbye.";

    let greetingPlaybackUrl: string | undefined;
    let greetingVoice: VoiceProviderActuallyUsed = this.blockTwilioSay()
      ? 'elevenlabs_silent_wait'
      : 'twilio_say_fallback';
    let finalFallbackAudioUrl: string | undefined;
    let finalFallbackVoice: VoiceProviderActuallyUsed = this.blockTwilioSay()
      ? 'elevenlabs_silent_wait'
      : 'twilio_say_fallback';

    const shouldTryElGreeting = shouldPlayInboundElevenLabsGreeting({
      hearingDebug,
      forceElevenLabsOnly: forceElOnly,
      voiceId: elOptsInbound.voiceId,
      publicOrigin: origin,
    });
    if (shouldTryElGreeting) {
      const inboundVoiceId = elOptsInbound.voiceId as string;
      const openingForTts = hearingDebug && forceElOnly ? debugOpeningText : inboundGreetingText;
      const gPlay = await this.voicePromptAudio.createPhrasePlaybackUrl(origin, {
        text: openingForTts,
        voiceId: inboundVoiceId,
        apiKey: elOptsInbound.apiKey,
        modelId: elOptsInbound.model,
      });
      if (gPlay.playbackUrl) {
        greetingPlaybackUrl = gPlay.playbackUrl;
        greetingVoice = 'elevenlabs';
        this.logger.log(
          JSON.stringify({
            event: 'agent.initial_greeting.played',
            callSessionId: session.id,
            agentId: context.agentId,
            voiceIdUsed: inboundVoiceId,
            greetingChars: openingForTts.length,
            fromPhraseCache: gPlay.fromPhraseCache,
            elevenLabsKeySource: elOptsInbound.keySource,
          }),
        );
        const agentGreetingSeq = await this.transcriptBuffer.getNextSequence(session.id);
        await this.transcriptBuffer.append(session.id, 'agent', openingForTts, agentGreetingSeq);
      } else {
        this.logger.error(
          JSON.stringify({
            event: 'agent.initial_greeting.failed',
            callSessionId: session.id,
            agentId: context.agentId,
            voiceIdUsed: inboundVoiceId,
            reason: 'elevenlabs_playback_url_missing',
            publicOriginHost: (() => {
              try {
                return new URL(origin).host;
              } catch {
                return 'invalid';
              }
            })(),
            elevenLabsKeyPresent: Boolean(elOptsInbound.apiKey?.trim()),
          }),
        );
      }
      const fPlay = await this.voicePromptAudio.createPhrasePlaybackUrl(origin, {
        text: fallbackText,
        voiceId: inboundVoiceId,
        apiKey: elOptsInbound.apiKey,
        modelId: elOptsInbound.model,
      });
      if (fPlay.playbackUrl) {
        finalFallbackAudioUrl = fPlay.playbackUrl;
        finalFallbackVoice = 'elevenlabs';
      }
    } else {
      this.logger.warn(
        JSON.stringify({
          event: 'agent.initial_greeting.skipped',
          callSessionId: session.id,
          reason: !elOptsInbound.voiceId
            ? 'missing_voice_id'
            : !/^https:\/\//i.test(origin)
              ? 'public_webhook_not_https'
              : hearingDebug && !forceElOnly
                ? 'gather_hearing_debug'
                : 'unknown',
          voiceIdUsed: elOptsInbound.voiceId ?? null,
        }),
      );
    }

    const strictElOnlyInbound = this.isStrictElevenLabsOnly();
    const greetingReplyVerb: 'Play' | 'Redirect' | 'Say' = greetingPlaybackUrl
      ? 'Play'
      : strictElOnlyInbound
        ? 'Redirect'
        : 'Say';
    const inboundPlaybackLog = this.voicePlaybackFields(Boolean(greetingPlaybackUrl));
    const voiceIdUsedInbound = elOptsInbound.voiceId ?? null;
    console.log(
      JSON.stringify({
        event: 'twilio.voice.inbound_voice_summary',
        loadedAgentId: context.agentId,
        dialedTo: maskPhoneForLog(payload.To),
        voiceProvider: context.agent.voiceProvider ?? null,
        voiceProviderRequested: 'elevenlabs',
        voiceIdUsed: voiceIdUsedInbound,
        voiceIdPresent: Boolean(context.agent.voiceId?.trim() || elOptsInbound.voiceId),
        voiceIdForElevenLabsTts: elOptsInbound.voiceId ? 'present' : 'missing',
        elevenLabsKeySource: elOptsInbound.keySource,
        providerUsed: inboundPlaybackLog.playbackChannel,
        voiceProviderActuallyUsed: inboundPlaybackLog.voiceProviderActuallyUsed,
        twimlVerbUsed: greetingReplyVerb,
        voiceProviderActuallyUsedOpening: hearingDebugEffective
          ? resolveVoiceProviderActuallyUsed(false, this.voiceProviderPolicy())
          : greetingVoice,
        voiceProviderActuallyUsedFinalFallback: hearingDebugEffective
          ? resolveVoiceProviderActuallyUsed(Boolean(finalFallbackAudioUrl), this.voiceProviderPolicy())
          : finalFallbackVoice,
        callSessionId: session.id,
        gatherActionUrlIncludesCallSessionId: gatherActionUrl.includes('callSessionId='),
        gatherActionUrlFull: gatherActionUrl,
        gatherActionUrlHost: (() => {
          try {
            return new URL(gatherActionUrl).host;
          } catch {
            return 'invalid_url';
          }
        })(),
        greetingReplyVerb,
        greetingUsedElevenLabsAudio: Boolean(greetingPlaybackUrl),
        gatherHearingDebugSayOnly: hearingDebugEffective,
        FORCE_ELEVENLABS_ONLY: forceElOnly,
      }),
    );

    this.logger.log(
      JSON.stringify({
        event: 'voice.runtime.url_summary',
        route: 'inbound',
        publicBaseUrl: origin,
        gatherActionUrl,
        playAudioUrl: hearingDebugEffective ? null : (greetingPlaybackUrl ?? null),
      }),
    );
    this.logger.log(
      JSON.stringify({
        event: 'voice.gather.capture_timing',
        callSessionId: session.id,
        greetingAudioMs: estimatedGreetingMs,
        timeUntilGatherListening: 0,
        speechDetected: false,
        speechResultChars: 0,
        emptySpeechRate: 0,
      }),
    );
    const twiml = this.finalizeTwiml(
      buildInboundGatherMvpTwiML({
        gatherActionUrl,
        language: hearingDebug ? 'en-US' : normalizeLanguageForTwilio(context.agent.language ?? 'en'),
        playbackAudioUrl: hearingDebugEffective ? undefined : greetingPlaybackUrl,
        openingSayText:
          !strictElOnlyInbound && (hearingDebugEffective || !greetingPlaybackUrl)
            ? inboundGreetingText
            : undefined,
        finalFallbackAudioUrl: hearingDebugEffective ? undefined : finalFallbackAudioUrl,
        finalFallbackSayText:
          strictElOnlyInbound || hearingDebugEffective || finalFallbackAudioUrl ? undefined : fallbackText,
        timeoutSeconds: 5,
        speechTimeout: 'auto',
        pauseBeforeListenSeconds: 0,
        includePromptInsideGather: false,
        blockTwilioSay: this.blockTwilioSay(),
      }),
      'inbound',
    );

    const greetingSeq = await this.transcriptBuffer.getNextSequence(session.id);
    await this.transcriptBuffer.append(
      session.id,
      'system',
      `Inbound call received from ${payload.From} to ${payload.To}.`,
      greetingSeq,
    );

    this.logger.log(
      JSON.stringify({
        event: 'twilio.voice.twiml_returned',
        route: 'inbound',
        callSessionId: session.id,
        agentResolved: true,
        twimlChars: twiml.length,
        playback: inboundPlaybackLog.playback,
        ttsFallbackUsed: !greetingPlaybackUrl && !this.blockTwilioSay(),
        playbackChannel: inboundPlaybackLog.playbackChannel,
        voiceProviderActuallyUsedOpening: hearingDebugEffective
          ? resolveVoiceProviderActuallyUsed(false, this.voiceProviderPolicy())
          : greetingVoice,
        voiceProviderActuallyUsedFinalFallback: hearingDebugEffective
          ? resolveVoiceProviderActuallyUsed(Boolean(finalFallbackAudioUrl), this.voiceProviderPolicy())
          : finalFallbackVoice,
        voiceProviderActuallyUsed: inboundPlaybackLog.voiceProviderActuallyUsed,
        twimlVerbUsed: greetingReplyVerb,
      }),
    );

    return {
      twiml,
      callSessionId: session.id,
      agentResolved: true,
    };
  }

  async handleGatherMvpVoice(payload: GatherMvpInboundPayload): Promise<GatherMvpWebhookResult> {
    const handlerStartedAt = Date.now();
    console.log('Gather body (keys):', Object.keys(payload as object).join(','));
    console.log(
      'Gather speech:',
      JSON.stringify({
        SpeechResult: (payload.SpeechResult ?? '').slice(0, 200),
        StableSpeechResult: (payload.StableSpeechResult ?? '').slice(0, 200),
        Confidence: payload.Confidence ?? '',
        CallSid: payload.CallSid ?? '',
      }),
    );

    this.logger.log(
      JSON.stringify({
        event: 'twilio.voice.gather_received',
        callSid: payload.CallSid,
        callSessionId: payload.callSessionId?.trim() || undefined,
        from: maskPhoneForLog(payload.From),
        to: maskPhoneForLog(payload.To),
        hasSpeechResult: Boolean(
          ((payload.SpeechResult ?? '').trim() || (payload.StableSpeechResult ?? '').trim()).length,
        ),
        confidence: payload.Confidence ?? undefined,
      }),
    );

    let callSessionId = payload.callSessionId?.trim() ?? '';
    if (!callSessionId && payload.CallSid) {
      const session = await this.callsService.findOneByTwilioCallSid(payload.CallSid);
      callSessionId = session?.id ?? '';
    }

    if (!callSessionId) {
      const gatherMissingPlayback = this.voicePlaybackFields(false);
      const twiml = this.finalizeTwiml(
        buildFallbackTwiML("I'm sorry, I couldn't resume your call. Please try again.", {
          blockTwilioSay: this.blockTwilioSay(),
        }),
        'gather_missing_session',
      );
      this.logger.warn(JSON.stringify({ event: 'twilio.voice.gather_missing_session', callSid: payload.CallSid }));
      this.logger.log(
        JSON.stringify({
          event: 'twilio.voice.twiml_returned',
          route: 'gather',
          agentResolved: false,
          twimlChars: twiml.length,
          playback: gatherMissingPlayback.playback,
          ttsFallbackUsed: !this.blockTwilioSay(),
          playbackChannel: gatherMissingPlayback.playbackChannel,
          voiceProviderActuallyUsed: gatherMissingPlayback.voiceProviderActuallyUsed,
        }),
      );
      return {
        twiml,
        agentResolved: false,
      };
    }

    const unstablePartial =
      typeof (payload as { UnstableSpeechResult?: string }).UnstableSpeechResult === 'string'
        ? (payload as { UnstableSpeechResult?: string }).UnstableSpeechResult!.trim()
        : '';
    if (unstablePartial) {
      await this.streamMetrics.recordPartialTranscript(callSessionId, unstablePartial);
    }
    await this.streamingSession.cancelDeferredJobForBargeIn(callSessionId);
    await this.streamMetrics.merge(callSessionId, {
      sttLatencyMs: Date.now() - handlerStartedAt,
      streamingMode: 'gather_deferred',
    });

    const ctx = await this.sessionContext.load(callSessionId);
    if (!ctx) {
      const gatherCtxPlayback = this.voicePlaybackFields(false);
      const twiml = this.finalizeTwiml(
        buildFallbackTwiML("I'm sorry, I couldn't load your call session. Please try again.", {
          blockTwilioSay: this.blockTwilioSay(),
        }),
        'gather_context_missing',
      );
      this.logger.warn(JSON.stringify({ event: 'twilio.voice.gather_context_missing', callSessionId }));
      this.logger.log(
        JSON.stringify({
          event: 'twilio.voice.twiml_returned',
          route: 'gather',
          agentResolved: false,
          twimlChars: twiml.length,
          playback: gatherCtxPlayback.playback,
          ttsFallbackUsed: !this.blockTwilioSay(),
          playbackChannel: gatherCtxPlayback.playbackChannel,
          voiceProviderActuallyUsed: gatherCtxPlayback.voiceProviderActuallyUsed,
        }),
      );
      return {
        twiml,
        agentResolved: false,
      };
    }

    const gatherSecretsRow = await this.prisma.agent.findUnique({
      where: { id: ctx.agentId },
      select: { secretsEnc: true },
    });
    const openAiKeyAudit = await this.auditOpenAiKeyForGather(
      ctx.tenantId,
      gatherSecretsRow?.secretsEnc,
      ctx.agentId,
    );
    this.logger.log(
      JSON.stringify({
        event: 'twilio.voice.gather_openai_key_proof',
        callSessionId,
        callSid: payload.CallSid,
        ...openAiKeyAudit,
      }),
    );

    const { keySource: gatherElevenLabsKeySource } = await this.resolveElevenLabsApiKeyAndSource(
      ctx.tenantId,
      gatherSecretsRow?.secretsEnc,
      ctx.agentId,
    );

    const session = await this.callsService.findOneById(callSessionId);
    if (session.status !== CallStatus.IN_PROGRESS) {
      await this.voiceRuntime.onRuntimeConnected(callSessionId);
    }

    const hearingDebug = this.isGatherHearingDebugMode();
    const hearingDebugEffective = this.resolveGatherHearingDebugEffective();
    const strictElevenLabsOnly = this.isStrictElevenLabsOnly();

    const speechGate = computeGatherSpeechGate({
      SpeechResult: payload.SpeechResult,
      StableSpeechResult: payload.StableSpeechResult,
      Confidence: payload.Confidence,
    });
    const speechText = speechGate.speechTextMerged;
    const confidence = speechGate.confidenceParsed;
    const hasUsableSpeech = speechGate.hasUsableSpeech;
    const willCallVoiceRuntime = speechGate.willCallVoiceRuntime;

    if (!speechText) {
      console.log(
        JSON.stringify({
          event: 'twilio.gather.empty_speech_diagnosis',
          callSid: payload.CallSid,
          callSessionId: payload.callSessionId?.trim() || null,
          checks: {
            spokeDuringPromptAudio:
              'Twilio only starts recognition after inner Play/Say/Pause finish; speech during greeting is dropped.',
            timeoutTooShort: 'Gather uses timeout=5s (start speaking) and speechTimeout=auto for conversational flow.',
            languageMismatch: 'Gather language is derived from agent/session; wrong code hurts recognition.',
            enhancedOrSpeechModel: 'enhanced and speechModel removed from TwiML for compatibility.',
            twilioPostedToGather:
              'This log line confirms Twilio reached your /api/twilio/voice/gather handler for this turn.',
          },
        }),
      );
    }
    let assistantResponse: string;
    const metadata =
      ctx.metadata && typeof ctx.metadata === 'object' && !Array.isArray(ctx.metadata)
        ? (ctx.metadata as Record<string, unknown>)
        : {};
    const gatherRetryCount = Number(metadata.gatherRetryCount ?? 0);
    this.logger.log(
      JSON.stringify({
        event: 'voice.gather.capture_timing',
        callSessionId,
        greetingAudioMs: 0,
        timeUntilGatherListening: 0,
        speechDetected: speechText.length > 0,
        speechResultChars: speechText.length,
        emptySpeechRate: speechText.length > 0 ? 0 : Math.min(1, (gatherRetryCount + 1) / (gatherRetryCount + 2)),
      }),
    );

    if (hasUsableSpeech) {
      this.logger.log(
        JSON.stringify({
          event: 'voice.speech.accepted',
          callSessionId,
          speechResult: speechText.slice(0, 500),
          confidence,
          reason: speechGate.acceptReason,
        }),
      );
    } else {
      this.logger.log(
        JSON.stringify({
          event: 'voice.speech.rejected',
          callSessionId,
          speechResult: speechText.slice(0, 500),
          confidence,
          reason: speechGate.rejectReason ?? 'empty',
        }),
      );
    }

    console.log(
      JSON.stringify({
        event: 'twilio.voice.gather_speech_gate',
        callSessionId,
        callSessionIdFromQuery: payload.callSessionId?.trim() || null,
        speechResultRaw: (payload.SpeechResult ?? '').slice(0, 300),
        stableSpeechRaw: (payload.StableSpeechResult ?? '').slice(0, 300),
        speechTextMerged: speechText.slice(0, 300),
        confidenceRawField: (payload.Confidence ?? '').trim() || null,
        confidenceParsed: confidence,
        hasUsableSpeech,
        willCallVoiceRuntime,
        voiceDeferredKickoff: willCallVoiceRuntime,
        openaiKeySource: openAiKeyAudit.openaiKeySource,
        openaiKeyFingerprint: openAiKeyAudit.openaiKeyFingerprint,
        agentKeyPresent: openAiKeyAudit.agentKeyPresent,
        tenantKeyPresent: openAiKeyAudit.tenantKeyPresent,
        envKeyPresent: openAiKeyAudit.envKeyPresent,
        agentOverridesWorkspaceOpenai: openAiKeyAudit.agentOverridesWorkspaceOpenai,
      }),
    );

    if (!speechText.trim()) {
      this.logger.log(
        JSON.stringify({
          event: 'twilio.voice.gather_twilio_speech_empty',
          callSessionId,
          callSid: payload.CallSid,
          diagnosis:
            'OpenAI key is not the cause. Twilio did not capture speech.',
        }),
      );
    }

    if (!hasUsableSpeech) {
      const nextRetry = gatherRetryCount + 1;
      await this.callsService.mergeSessionMetadata(callSessionId, { gatherRetryCount: nextRetry });

      const seq = await this.transcriptBuffer.getNextSequence(callSessionId);
      await this.transcriptBuffer.append(
        callSessionId,
        'system',
        !speechText
          ? 'No speech captured from Twilio Gather.'
          : `No meaningful speech from Twilio Gather (reason=${speechGate.rejectReason ?? 'unknown'}).`,
        seq,
      );

      if (nextRetry >= 2) {
        const finalMsg =
          ctx.agent.fallbackMessage?.trim() ??
          'I am having trouble hearing you. Please call again or wait for a human assistant.';
        const seqA = await this.transcriptBuffer.getNextSequence(callSessionId);
        await this.transcriptBuffer.append(callSessionId, 'agent', finalMsg, seqA);

        const origin = this.getPublicBaseUrl();
        const { playbackUrl: finalPlay } = await this.buildElevenLabsPlaybackUrl(origin, finalMsg, {
          callSessionId,
          tenantId: ctx.tenantId,
          phase: 'gather_reply',
          voiceId: this.resolveElevenLabsVoiceId(ctx.agent),
          elevenlabsApiKey: ctx.agent.elevenlabsApiKey ?? undefined,
          elevenlabsModel: ctx.agent.elevenlabsModel ?? undefined,
        });
        const terminalPlayback = this.voicePlaybackFields(Boolean(finalPlay));
        const twiml = this.finalizeTwiml(
          buildVoiceTerminalTwiml({
            playbackAudioUrl: finalPlay,
            sayText: finalPlay ? undefined : finalMsg,
            language: this.getSessionLanguage(ctx),
            blockTwilioSay: this.blockTwilioSay(),
          }),
          'gather_timeout',
        );

        console.log(
          JSON.stringify({
            event: 'twilio.voice.gather_terminal_empty_speech',
            callSessionId,
            emptyAttempts: nextRetry,
            loadedAgentId: ctx.agentId,
            dialedTo: maskPhoneForLog(payload.To),
            voiceProvider: ctx.agent.voiceProvider ?? null,
            voiceIdPresent: Boolean(ctx.agent.voiceId?.trim()),
            elevenLabsKeySource: gatherElevenLabsKeySource,
            replyVerb: finalPlay ? 'Play' : this.blockTwilioSay() ? 'Hangup' : 'Say',
            voiceProviderActuallyUsed: terminalPlayback.voiceProviderActuallyUsed,
            SpeechResult: speechText.slice(0, 200),
            StableSpeechResult: (payload.StableSpeechResult ?? '').slice(0, 200),
            Confidence: payload.Confidence ?? '',
          }),
        );
        this.logger.log(
          JSON.stringify({
            event: 'twilio.voice.twiml_returned',
            route: 'gather',
            callSessionId,
            agentResolved: true,
            twimlChars: twiml.length,
            playback: terminalPlayback.playback,
            terminal: true,
            voiceProviderActuallyUsed: terminalPlayback.voiceProviderActuallyUsed,
            'twilio.response_latency_ms': Date.now() - handlerStartedAt,
          }),
        );
        return { twiml, callSessionId, agentResolved: true };
      }

      assistantResponse = "Sorry, I didn't catch that. Could you please repeat it?";
      const seq2 = await this.transcriptBuffer.getNextSequence(callSessionId);
      await this.transcriptBuffer.append(callSessionId, 'agent', assistantResponse, seq2);
      this.logger.log(
        JSON.stringify({
          event: 'twilio.voice.llm_reply_skipped',
          callSessionId,
          reason: !speechText ? 'empty_gather_speech' : `meaningless_gather_speech_${speechGate.rejectReason ?? 'unknown'}`,
          confidence,
          replyChars: assistantResponse.length,
          retryAttempt: nextRetry,
        }),
      );
    } else {
      await this.callsService.mergeSessionMetadata(callSessionId, {
        gatherRetryCount: 0,
        rawSpeechTranscript: speechText,
      });
      this.logger.log(
        JSON.stringify({
          event: 'voice.journey.twilio_speech_received',
          callSessionId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          speechCharCount: speechText.length,
          voicePipeline: 'deferred_async',
          spellingModeActive:
            metadata.voiceMode === 'SPELLING_CAPTURE' || metadata.orderState === 'EMAIL_COLLECTING',
        }),
      );

      const originEarly = this.getPublicBaseUrl();
      const orderStateForAck =
        typeof metadata.orderState === 'string' && metadata.orderState.trim()
          ? metadata.orderState.trim()
          : 'IDLE';
      const userIntent = classifyUserIntent(speechText);
      const voicePolicy = this.voiceProviderPolicy();
      this.logVoiceProviderEnforced(callSessionId, 'gather');

      const ackSelection = selectInstantAcknowledgement({
        intent: userIntent,
        speechText,
        callState: orderStateForAck,
        metadata,
        forceElevenLabsOnly: voicePolicy.twilioSayBlocked,
      });
      const letMeCheckUsedBefore = metadata.letMeCheckUsed === true;

      if (ackSelection.mode === 'sync_full_reply') {
        const latencyTimer = new VoiceLatencyTimer();
        latencyTimer.startSection('intentDetectionMs');
        const instantReplyText = buildInstantReply(
          speechText,
          ctx.store?.name ?? 'SureShot Books',
        );
        const intentDetectionMs = latencyTimer.endSection('intentDetectionMs');
        latencyTimer.mark('instantReplyMs', 0);
        latencyTimer.mark('normalizationMs', 0);
        latencyTimer.mark('openaiMs', 0);

        void this.voiceRuntime
          .recordInstantTurn({
            callSessionId,
            userText: speechText,
            reply: instantReplyText,
            userIntent,
          })
          .then((dbMs) => latencyTimer.mark('dbMs', dbMs))
          .catch(() => undefined);

        const syncPatch = buildInstantAckMetadataPatch({
          selection: ackSelection,
          intent: userIntent,
          letMeCheckUsedBefore,
          instantPhraseForLog: null,
          syncReplyText: instantReplyText,
        });
        void this.callsService.mergeSessionMetadata(callSessionId, syncPatch);

        this.logger.log(
          JSON.stringify({
            event: 'twilio.voice.instant_ack_selected',
            callSessionId,
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            instantAckSelected: instantReplyText.slice(0, 160),
            ackReason: ackSelection.ackReason,
            intentDetected: userIntent,
            pipeline: 'sync_full_reply_no_deferred',
            instant_reply_used: true,
            openaiCalled: false,
          }),
        );

        const gatherActionUrlSync = `${originEarly}/api/twilio/voice/gather?callSessionId=${encodeURIComponent(
          callSessionId,
        )}`;
        const gatherFallbackTextSync =
          ctx.agent.fallbackMessage?.trim() ?? "We're having trouble hearing you. Please call again later. Goodbye.";
        const hearingDebugEffectiveSync = this.resolveGatherHearingDebugEffective();
        const voiceIdSync = this.resolveElevenLabsVoiceId(ctx.agent);
        const modelSync = this.voicePromptAudio.resolveLatencyModelId(ctx.agent.elevenlabsModel ?? null);

        latencyTimer.startSection('ttsMs');
        const mainPlay = this.voicePromptAudio.resolveCachedPhrasePlaybackUrl(originEarly, {
          text: instantReplyText,
          voiceId: voiceIdSync ?? '',
          modelId: modelSync,
          callSessionId,
        });
        const ttsMs = latencyTimer.endSection('ttsMs');

        const finalFbSync = this.voicePromptAudio.resolveCachedPhrasePlaybackUrl(originEarly, {
          text: gatherFallbackTextSync,
          voiceId: voiceIdSync ?? '',
          modelId: modelSync,
          callSessionId,
        });
        this.logger.log(
          JSON.stringify({
            event: 'voice.runtime.url_summary',
            route: 'gather_sync_social_reply',
            publicBaseUrl: originEarly,
            gatherActionUrl: gatherActionUrlSync,
            playAudioUrl: mainPlay.playbackUrl ?? null,
            voice_audio_cache_hit: mainPlay.fromPhraseCache,
            ttsGenerated: mainPlay.ttsGenerated,
          }),
        );
        const syncPlayback = this.voicePlaybackFields(Boolean(mainPlay.playbackUrl));
        const syncGatherTiming = resolveGatherTwiMLOptions(metadata, {
          speechTimeout: '2',
          timeoutSeconds: 10,
          pauseBeforeListenSeconds: 0,
        });
        const useTwilioSayFallback =
          !mainPlay.playbackUrl && !strictElevenLabsOnly && !this.blockTwilioSay();
        const twimlSync = this.finalizeTwiml(
          buildInboundGatherMvpTwiML({
            gatherActionUrl: gatherActionUrlSync,
            language: this.getSessionLanguage(ctx),
            playbackAudioUrl: mainPlay.playbackUrl,
            finalFallbackAudioUrl: finalFbSync.playbackUrl,
            openingSayText: useTwilioSayFallback ? instantReplyText : undefined,
            finalFallbackSayText:
              strictElevenLabsOnly || finalFbSync.playbackUrl ? undefined : gatherFallbackTextSync,
            timeoutSeconds: syncGatherTiming.timeoutSeconds,
            speechTimeout: syncGatherTiming.speechTimeout,
            pauseBeforeListenSeconds: syncGatherTiming.pauseBeforeListenSeconds,
            blockTwilioSay: this.blockTwilioSay(),
          }),
          'gather_sync_social_reply',
        );

        const breakdown = latencyTimer.toBreakdown({
          callSessionId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          route: 'gather_sync_social_reply',
          intentDetectionMs,
          instantReplyMs: 0,
          ttsMs,
          instantReplyUsed: true,
          openaiCalled: false,
          ttsGenerated: mainPlay.ttsGenerated,
          audioCacheHit: mainPlay.fromPhraseCache,
          openaiSkippedReason: 'instant_deterministic_sync',
          elevenlabsModel: modelSync,
          elevenlabsLatencyMs: mainPlay.ttsGenerated ? ttsMs : 0,
          audioCacheKey: mainPlay.audioCacheKey.slice(0, 16),
        });
        logVoiceLatencyBreakdown(breakdown);

        this.logTwilioResponseMetrics('gather_sync_social_reply', callSessionId, handlerStartedAt);
        this.logger.log(
          JSON.stringify({
            event: 'twilio.voice.twiml_returned',
            route: 'gather_sync_social_reply',
            callSessionId,
            agentResolved: true,
            twimlChars: twimlSync.length,
            playback: syncPlayback.playback,
            intentDetected: userIntent,
            voiceProviderActuallyUsedMain: syncPlayback.voiceProviderActuallyUsed,
            responseDelayMs: breakdown.totalCallerWaitMs,
            instant_reply_used: true,
            openaiCalled: false,
            ttsGenerated: mainPlay.ttsGenerated,
            voice_audio_cache_hit: mainPlay.fromPhraseCache,
            'twilio.response_latency_ms': breakdown.totalCallerWaitMs,
          }),
        );
        return {
          twiml: twimlSync,
          callSessionId,
          agentResolved: true,
        };
      }

      const kickText =
        ackSelection.mode === 'deferred_kickoff' ? (ackSelection.instantPhrase?.trim() ?? '') : '';
      const deferredPatch = buildInstantAckMetadataPatch({
        selection: ackSelection,
        intent: userIntent,
        letMeCheckUsedBefore,
        instantPhraseForLog: null,
      });
      const letMeCheckUsedAfter = deferredPatch.letMeCheckUsed;

      const jobId = randomUUID();
      await this.callsService.mergeSessionMetadata(callSessionId, {
        ...deferredPatch,
        deferredVoiceJob: {
          jobId,
          phase: 'processing',
          startedAtMs: Date.now(),
          momentPromptPlayed: false,
        },
      });
      this.kickDeferredVoiceProcessing(callSessionId, speechText, jobId);

      const deferPollUrl = `${originEarly}/api/twilio/voice/deferred-poll?callSessionId=${encodeURIComponent(
        callSessionId,
      )}`;

      let kickPhrase: { playbackUrl?: string; voiceProviderActuallyUsed: VoiceProviderActuallyUsed } = {
        voiceProviderActuallyUsed: resolveVoiceProviderActuallyUsed(false, this.voiceProviderPolicy()),
      };
      if (kickText.length > 0) {
        const voiceIdKick = this.resolveElevenLabsVoiceId(ctx.agent);
        const modelKick = this.voicePromptAudio.resolveLatencyModelId(ctx.agent.elevenlabsModel);
        const cachedKick = this.voicePromptAudio.resolveCachedPhrasePlaybackUrl(originEarly, {
          text: kickText,
          voiceId: voiceIdKick ?? '',
          modelId: modelKick,
          callSessionId,
        });
        if (cachedKick.playbackUrl) {
          kickPhrase = {
            playbackUrl: cachedKick.playbackUrl,
            voiceProviderActuallyUsed: resolveVoiceProviderActuallyUsed(true, this.voiceProviderPolicy()),
          };
        } else {
          const kickBudgetMs = Math.max(150, 800 - (Date.now() - handlerStartedAt));
          kickPhrase = await this.withTimeout(
            this.resolveShortPhrasePlayUrl({
              origin: originEarly,
              hearingDebugEffective,
              text: kickText,
              tenantId: ctx.tenantId,
              callSessionId,
              agent: ctx.agent,
              logLabel: 'deferred_kickoff',
            }),
            kickBudgetMs,
            {
              voiceProviderActuallyUsed: resolveVoiceProviderActuallyUsed(
                false,
                this.voiceProviderPolicy(),
              ),
            },
          );
        }
      }

      const kickPlaybackLog = this.voicePlaybackFields(Boolean(kickPhrase.playbackUrl));
      this.logger.log(
        JSON.stringify({
          event: 'voice.runtime.url_summary',
          route: 'gather_deferred_kickoff',
          publicBaseUrl: originEarly,
          gatherActionUrl: deferPollUrl,
          playAudioUrl: kickPhrase.playbackUrl ?? null,
        }),
      );
      const twimlKickoff = this.finalizeTwiml(
        buildDeferredVoiceKickoffTwiML({
          deferPollUrl,
          instantPlaybackUrl: kickPhrase.playbackUrl,
          allowTwilioSayFallback: false,
          blockTwilioSay: this.blockTwilioSay(),
          instantSayText: !kickPhrase.playbackUrl && kickText.length > 0 ? kickText : undefined,
          language: this.getSessionLanguage(ctx),
        }),
        'gather_deferred_kickoff',
      );

      this.logTwilioResponseMetrics('gather_deferred_kickoff', callSessionId, handlerStartedAt);

      this.logger.log(
        JSON.stringify({
          event: 'twilio.voice.instant_ack_selected',
          callSessionId,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          instantAckSelected: kickText.length > 0 ? kickText : '(silent)',
          ackReason: ackSelection.ackReason,
          letMeCheckUsedBefore,
          letMeCheckUsedAfter,
          intentDetected: userIntent,
        }),
      );

      this.logger.log(
        JSON.stringify({
          event: 'twilio.voice.gather_deferred_kickoff',
          callSessionId,
          agentId: ctx.agentId,
          tenantId: ctx.tenantId,
          jobId,
          speechPreview: speechText.slice(0, 200),
          voiceProviderActuallyUsed: kickPhrase.voiceProviderActuallyUsed,
          deferredKickoffPhrase: kickText.length > 0 ? kickText : null,
          responseDelayMs: Date.now() - handlerStartedAt,
          slowHandlerWarning: Date.now() - handlerStartedAt > 2000,
          'twilio.response_latency_ms': Date.now() - handlerStartedAt,
        }),
      );

      this.logger.log(
        JSON.stringify({
          event: 'twilio.voice.twiml_returned',
          route: 'gather_deferred_kickoff',
          callSessionId,
          agentResolved: true,
          twimlChars: twimlKickoff.length,
          playback: kickPlaybackLog.playback,
          ttsFallbackUsed: false,
          playbackChannel: kickPlaybackLog.playbackChannel,
          replyVerb: kickPhrase.playbackUrl ? 'Play' : 'Redirect',
          deferredPipeline: true,
          voiceProviderActuallyUsed: kickPhrase.voiceProviderActuallyUsed,
          'twilio.response_latency_ms': Date.now() - handlerStartedAt,
        }),
      );

      return {
        twiml: twimlKickoff,
        callSessionId,
        agentResolved: true,
      };
    }

    const origin = this.getPublicBaseUrl();
    const gatherActionUrl = `${origin}/api/twilio/voice/gather?callSessionId=${encodeURIComponent(
      callSessionId,
    )}`;

    const gatherFallbackText =
      ctx.agent.fallbackMessage?.trim() ?? "We're having trouble hearing you. Please call again later. Goodbye.";

    const retryOpen = await this.resolveShortPhrasePlayUrl({
      origin,
      hearingDebugEffective,
      text: assistantResponse,
      tenantId: ctx.tenantId,
      callSessionId,
      agent: ctx.agent,
      logLabel: 'gather_retry_opening',
      allowWhenLlmReplyActive: true,
    });
    const retryFinal = await this.resolveShortPhrasePlayUrl({
      origin,
      hearingDebugEffective,
      text: gatherFallbackText,
      tenantId: ctx.tenantId,
      callSessionId,
      agent: ctx.agent,
      logLabel: 'gather_retry_final_fallback',
      allowWhenLlmReplyActive: true,
    });

    this.logger.log(
      JSON.stringify({
        event: 'voice.runtime.url_summary',
        route: 'gather',
        publicBaseUrl: origin,
        gatherActionUrl,
        playAudioUrl: retryOpen.playbackUrl ?? null,
      }),
    );
    const retryPlaybackLog = this.voicePlaybackFields(Boolean(retryOpen.playbackUrl));
    const gatherTiming = resolveGatherTwiMLOptions(metadata, {
      speechTimeout: '2',
      timeoutSeconds: 10,
      pauseBeforeListenSeconds: 0,
    });
    const twiml = this.finalizeTwiml(
      buildInboundGatherMvpTwiML({
        gatherActionUrl,
        language: this.getSessionLanguage(ctx),
        playbackAudioUrl: retryOpen.playbackUrl,
        finalFallbackAudioUrl: retryFinal.playbackUrl,
        openingSayText: strictElevenLabsOnly || retryOpen.playbackUrl ? undefined : assistantResponse,
        finalFallbackSayText: strictElevenLabsOnly || retryFinal.playbackUrl ? undefined : gatherFallbackText,
        timeoutSeconds: gatherTiming.timeoutSeconds,
        speechTimeout: gatherTiming.speechTimeout,
        pauseBeforeListenSeconds: gatherTiming.pauseBeforeListenSeconds,
        includePromptInsideGather: false,
        blockTwilioSay: this.blockTwilioSay(),
      }),
      'gather_retry',
    );

    const replyVerb: 'Play' | 'Say' | 'Gather' = retryOpen.playbackUrl
      ? 'Play'
      : strictElevenLabsOnly
        ? 'Gather'
        : 'Say';

    this.logTwilioResponseMetrics('gather_retry_prompt', callSessionId, handlerStartedAt);

    console.log({
      speechResult: speechText.slice(0, 500),
      confidence,
      callSessionId,
      agentId: ctx.agentId,
      tenantId: ctx.tenantId,
      openaiCalled: false,
      openaiReply: assistantResponse.slice(0, 500),
      elevenLabsAudioCreated: Boolean(retryOpen.playbackUrl),
      replyVerb,
      twimlReplyVerb: replyVerb,
      ttsProviderUsed: retryPlaybackLog.playbackChannel,
      voiceProviderActuallyUsedOpening: retryOpen.voiceProviderActuallyUsed,
      voiceProviderActuallyUsedFinalFallback: retryFinal.voiceProviderActuallyUsed,
      gatherRetrySayOnly: !retryOpen.playbackUrl && !strictElevenLabsOnly,
    });

    console.log(
      JSON.stringify({
        event: 'twilio.voice.gather_reply_summary',
        loadedAgentId: ctx.agentId,
        dialedTo: maskPhoneForLog(payload.To),
        voiceProvider: ctx.agent.voiceProvider ?? null,
        voiceIdPresent: Boolean(ctx.agent.voiceId?.trim()),
        resolvedVoiceIdForElevenLabs: this.resolveElevenLabsVoiceId(ctx.agent) ? 'present' : 'missing',
        elevenLabsKeySource: gatherElevenLabsKeySource,
        providerUsed: retryPlaybackLog.playbackChannel,
        callSessionId,
        nextGatherUrlIncludesCallSessionId: gatherActionUrl.includes('callSessionId='),
        SpeechResult: speechText.slice(0, 200),
        StableSpeechResult: (payload.StableSpeechResult ?? '').slice(0, 200),
        Confidence: payload.Confidence ?? '',
        replyVerb,
        replyUsedElevenLabsAudio: Boolean(retryOpen.playbackUrl),
        twimlHasRedirectToInbound: /<\s*Redirect/i.test(twiml),
      }),
    );

    this.logger.log(
      JSON.stringify({
        event: 'twilio.voice.twiml_returned',
        route: 'gather',
        callSessionId,
        agentResolved: true,
        twimlChars: twiml.length,
        playback: retryPlaybackLog.playback,
        ttsFallbackUsed: !retryOpen.playbackUrl && !this.blockTwilioSay(),
        playbackChannel: retryPlaybackLog.playbackChannel,
        replyVerb,
        voiceProviderActuallyUsedOpening: retryOpen.voiceProviderActuallyUsed,
        voiceProviderActuallyUsedFinalFallback: retryFinal.voiceProviderActuallyUsed,
        voiceProviderActuallyUsed: retryPlaybackLog.voiceProviderActuallyUsed,
        'twilio.response_latency_ms': Date.now() - handlerStartedAt,
      }),
    );

    return {
      twiml,
      callSessionId,
      agentResolved: true,
    };
  }

  /**
   * Poll endpoint after deferred kickoff: cheap TwiML only until async OpenAI + (optional) ElevenLabs finish.
   */
  async handleDeferredVoicePoll(payload: DeferredPollInboundPayload): Promise<GatherMvpWebhookResult> {
    const handlerStartedAt = Date.now();

    let callSessionId = payload.callSessionId?.trim() ?? '';
    if (!callSessionId && payload.CallSid) {
      const session = await this.callsService.findOneByTwilioCallSid(payload.CallSid);
      callSessionId = session?.id ?? '';
    }

    const origin = this.getPublicBaseUrl();
    const deferPollUrl = `${origin}/api/twilio/voice/deferred-poll?callSessionId=${encodeURIComponent(
      callSessionId || 'missing',
    )}`;

    if (!callSessionId) {
      const twiml = this.finalizeTwiml(
        buildFallbackTwiML("I'm sorry, I couldn't resume your call. Please try again.", {
          blockTwilioSay: this.blockTwilioSay(),
        }),
        'deferred_poll_missing_session',
      );
      this.logTwilioResponseMetrics('deferred_poll', undefined, handlerStartedAt);
      return { twiml, agentResolved: false };
    }

    const ctx = await this.sessionContext.load(callSessionId);
    if (!ctx) {
      const twiml = this.finalizeTwiml(
        buildFallbackTwiML("I'm sorry, I couldn't load your call session. Please try again.", {
          blockTwilioSay: this.blockTwilioSay(),
        }),
        'deferred_poll_context_missing',
      );
      this.logTwilioResponseMetrics('deferred_poll', callSessionId, handlerStartedAt);
      return { twiml, agentResolved: false };
    }

    const row = await this.callsService.findOneById(callSessionId);
    if (row.twilioCallSid && payload.CallSid !== row.twilioCallSid) {
      const twiml = this.finalizeTwiml(
        buildFallbackTwiML('Sorry, this call could not be verified. Please try again.', {
          blockTwilioSay: this.blockTwilioSay(),
        }),
        'deferred_poll_sid_mismatch',
      );
      this.logger.warn(
        JSON.stringify({
          event: 'twilio.voice.deferred_poll_call_sid_mismatch',
          callSessionId,
        }),
      );
      this.logTwilioResponseMetrics('deferred_poll_sid_mismatch', callSessionId, handlerStartedAt);
      return { twiml, callSessionId, agentResolved: false };
    }
    const meta =
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {};
    const deferredGatherTiming = resolveGatherTwiMLOptions(meta, {
      speechTimeout: '2',
      timeoutSeconds: 10,
      pauseBeforeListenSeconds: 0,
    });
    const jobRaw = meta.deferredVoiceJob;
    const job = jobRaw && typeof jobRaw === 'object' && !Array.isArray(jobRaw) ? (jobRaw as DeferredVoiceJobMetadata) : null;

    const gatherActionUrl = `${origin}/api/twilio/voice/gather?callSessionId=${encodeURIComponent(callSessionId)}`;
    const gatherFallbackText =
      ctx.agent.fallbackMessage?.trim() ?? "We're having trouble hearing you. Please call again later. Goodbye.";
    const hearingDebug = this.isGatherHearingDebugMode();
    const hearingDebugEffective = this.resolveGatherHearingDebugEffective();
    const strictElevenLabsOnly = this.isStrictElevenLabsOnly();

    if (!job || !('phase' in job)) {
      const missOpen = "I didn't catch that. Could you repeat your question?";
      const missA = await this.resolveShortPhrasePlayUrl({
        origin,
        hearingDebugEffective,
        text: missOpen,
        tenantId: ctx.tenantId,
        callSessionId,
        agent: ctx.agent,
        logLabel: 'deferred_poll_missing_opening',
      });
      const missB = await this.resolveShortPhrasePlayUrl({
        origin,
        hearingDebugEffective,
        text: gatherFallbackText,
        tenantId: ctx.tenantId,
        callSessionId,
        agent: ctx.agent,
        logLabel: 'deferred_poll_missing_fallback',
      });
      this.logger.log(
        JSON.stringify({
          event: 'voice.runtime.url_summary',
          route: 'deferred_poll_recover',
          publicBaseUrl: origin,
          gatherActionUrl,
          playAudioUrl: missA.playbackUrl ?? null,
        }),
      );
      const twiml = this.finalizeTwiml(
        buildInboundGatherMvpTwiML({
          gatherActionUrl,
          language: this.getSessionLanguage(ctx),
          playbackAudioUrl: missA.playbackUrl,
          finalFallbackAudioUrl: missB.playbackUrl,
          openingSayText: strictElevenLabsOnly || missA.playbackUrl ? undefined : missOpen,
          finalFallbackSayText: strictElevenLabsOnly || missB.playbackUrl ? undefined : gatherFallbackText,
          timeoutSeconds: deferredGatherTiming.timeoutSeconds,
          speechTimeout: deferredGatherTiming.speechTimeout,
          pauseBeforeListenSeconds: deferredGatherTiming.pauseBeforeListenSeconds,
          blockTwilioSay: this.blockTwilioSay(),
        }),
        'deferred_poll_recover',
      );
      this.logTwilioResponseMetrics('deferred_poll_recover', callSessionId, handlerStartedAt);
      this.logger.log(
        JSON.stringify({
          event: 'twilio.voice.deferred_poll_missing_job',
          callSessionId,
          voiceProviderActuallyUsedOpening: missA.voiceProviderActuallyUsed,
          voiceProviderActuallyUsedFinalFallback: missB.voiceProviderActuallyUsed,
          'twilio.response_latency_ms': Date.now() - handlerStartedAt,
        }),
      );
      return { twiml, callSessionId, agentResolved: true };
    }

    if (job.phase === 'processing') {
      const elapsed = Date.now() - job.startedAtMs;
      if (elapsed > 120_000) {
        await this.callsService.mergeSessionMetadata(callSessionId, { deferredVoiceJob: null });
        const timeoutOpen =
          ctx.agent.fallbackMessage?.trim() ?? "I'm sorry, that took too long. Please try your question again.";
        const toA = await this.resolveShortPhrasePlayUrl({
          origin,
          hearingDebugEffective,
          text: timeoutOpen,
          tenantId: ctx.tenantId,
          callSessionId,
          agent: ctx.agent,
          logLabel: 'deferred_poll_timeout_opening',
        });
        const toB = await this.resolveShortPhrasePlayUrl({
          origin,
          hearingDebugEffective,
          text: gatherFallbackText,
          tenantId: ctx.tenantId,
          callSessionId,
          agent: ctx.agent,
          logLabel: 'deferred_poll_timeout_fallback',
        });
        this.logger.log(
          JSON.stringify({
            event: 'voice.runtime.url_summary',
            route: 'deferred_poll_timeout',
            publicBaseUrl: origin,
            gatherActionUrl,
            playAudioUrl: toA.playbackUrl ?? null,
          }),
        );
        const twiml = this.finalizeTwiml(
          buildInboundGatherMvpTwiML({
            gatherActionUrl,
            language: this.getSessionLanguage(ctx),
            playbackAudioUrl: toA.playbackUrl,
            finalFallbackAudioUrl: toB.playbackUrl,
            openingSayText: strictElevenLabsOnly || toA.playbackUrl ? undefined : timeoutOpen,
            finalFallbackSayText: strictElevenLabsOnly || toB.playbackUrl ? undefined : gatherFallbackText,
            timeoutSeconds: deferredGatherTiming.timeoutSeconds,
            speechTimeout: deferredGatherTiming.speechTimeout,
            pauseBeforeListenSeconds: deferredGatherTiming.pauseBeforeListenSeconds,
            blockTwilioSay: this.blockTwilioSay(),
          }),
          'deferred_poll_timeout',
        );
        this.logTwilioResponseMetrics('deferred_poll_timeout', callSessionId, handlerStartedAt);
        return { twiml, callSessionId, agentResolved: true };
      }
      const fillerThresholdMs = voiceSearchFillerThresholdMs();
      const voicePolicyPoll = this.voiceProviderPolicy();
      if (
        elapsed > fillerThresholdMs &&
        !job.momentPromptPlayed &&
        shouldPlayDeferredSearchFiller(voicePolicyPoll)
      ) {
        await this.callsService.mergeSessionMetadata(callSessionId, {
          deferredVoiceJob: { ...job, momentPromptPlayed: true },
        });
        const lastIntent =
          typeof meta.lastIntentDetected === 'string'
            ? (meta.lastIntentDetected as UserUtteranceIntent)
            : 'product_search';
        const fillerText = pickVoiceSearchFillerPhrase({
          callSessionId,
          intent: lastIntent,
          queryPreview:
            typeof meta.lastProductQuery === 'string' ? meta.lastProductQuery : undefined,
        });
        const fillerPlay = await this.resolveShortPhrasePlayUrl({
          origin,
          hearingDebugEffective,
          text: fillerText,
          tenantId: ctx.tenantId,
          callSessionId,
          agent: ctx.agent,
          logLabel: 'deferred_poll_search_filler',
        });
        const twimlFiller = this.finalizeTwiml(
          buildDeferredVoiceMomentPleaseTwiML({
            deferPollUrl,
            playbackUrl: fillerPlay.playbackUrl,
            sayFallbackText: fillerText,
            allowTwilioSayFallback: false,
            blockTwilioSay: this.blockTwilioSay(),
            language: this.getSessionLanguage(ctx),
          }),
          'deferred_poll_filler',
        );
        this.logTwilioResponseMetrics('deferred_poll_filler', callSessionId, handlerStartedAt);
        this.logger.log(
          JSON.stringify({
            event: 'twilio.voice.deferred_poll',
            sub: 'search_filler',
            callSessionId,
            elapsedMs: elapsed,
            fillerText: fillerText.slice(0, 120),
            voiceProvider: fillerPlay.voiceProviderActuallyUsed,
            'twilio.response_latency_ms': Date.now() - handlerStartedAt,
          }),
        );
        return { twiml: twimlFiller, callSessionId, agentResolved: true };
      }
      const twiml = this.finalizeTwiml(
        buildDeferredVoicePollPauseTwiML({
          deferPollUrl,
          pauseSeconds: voiceDeferredPollPauseSeconds(),
        }),
        'deferred_poll_pause',
      );
      this.logTwilioResponseMetrics('deferred_poll_pause', callSessionId, handlerStartedAt);
      this.logger.log(
        JSON.stringify({
          event: 'twilio.voice.deferred_poll',
          sub: 'pause',
          callSessionId,
          elapsedMs: elapsed,
          'twilio.response_latency_ms': Date.now() - handlerStartedAt,
        }),
      );
      return { twiml, callSessionId, agentResolved: true };
    }

    if (job.phase === 'failed') {
      await this.callsService.mergeSessionMetadata(callSessionId, { deferredVoiceJob: null });
      const msg = ctx.agent.fallbackMessage ?? "I'm having trouble right now. Please call back later.";
      const failA = await this.resolveShortPhrasePlayUrl({
        origin,
        hearingDebugEffective,
        text: msg,
        tenantId: ctx.tenantId,
        callSessionId,
        agent: ctx.agent,
        logLabel: 'deferred_poll_failed_opening',
      });
      const failB = await this.resolveShortPhrasePlayUrl({
        origin,
        hearingDebugEffective,
        text: gatherFallbackText,
        tenantId: ctx.tenantId,
        callSessionId,
        agent: ctx.agent,
        logLabel: 'deferred_poll_failed_fallback',
      });
      this.logger.log(
        JSON.stringify({
          event: 'voice.runtime.url_summary',
          route: 'deferred_poll_failed',
          publicBaseUrl: origin,
          gatherActionUrl,
          playAudioUrl: failA.playbackUrl ?? null,
        }),
      );
      const twiml = this.finalizeTwiml(
        buildInboundGatherMvpTwiML({
          gatherActionUrl,
          language: this.getSessionLanguage(ctx),
          playbackAudioUrl: failA.playbackUrl,
          finalFallbackAudioUrl: failB.playbackUrl,
          openingSayText: strictElevenLabsOnly || failA.playbackUrl ? undefined : msg,
          finalFallbackSayText: strictElevenLabsOnly || failB.playbackUrl ? undefined : gatherFallbackText,
          timeoutSeconds: deferredGatherTiming.timeoutSeconds,
          speechTimeout: deferredGatherTiming.speechTimeout,
          pauseBeforeListenSeconds: deferredGatherTiming.pauseBeforeListenSeconds,
          blockTwilioSay: this.blockTwilioSay(),
        }),
        'deferred_poll_failed',
      );
      this.logTwilioResponseMetrics('deferred_poll_failed', callSessionId, handlerStartedAt);
      return { twiml, callSessionId, agentResolved: true };
    }

    // ready — single Play for orchestrator reply; no phrase_audio fallback after llmReplyGenerated
    await this.callsService.mergeSessionMetadata(callSessionId, { deferredVoiceJob: null });
    const playbackAudioUrl = job.playbackUrl?.trim() || undefined;
    let finalFallbackAudioUrl: string | undefined;
    if (!playbackAudioUrl) {
      const readyFall = await this.resolveShortPhrasePlayUrl({
        origin,
        hearingDebugEffective,
        text: gatherFallbackText,
        tenantId: ctx.tenantId,
        callSessionId,
        agent: ctx.agent,
        logLabel: 'deferred_poll_ready_final_fallback',
      });
      finalFallbackAudioUrl = readyFall.playbackUrl;
    } else {
      this.logger.log(
        JSON.stringify({
          event: 'voice.single_reply.enforced',
          callSessionId,
          route: 'deferred_poll_ready',
          skippedPhraseAudio: ['deferred_poll_ready_final_fallback'],
          llmReplyChars: job.assistantResponse?.length ?? 0,
        }),
      );
    }
    this.logger.log(
      JSON.stringify({
        event: 'voice.runtime.url_summary',
        route: 'deferred_poll_ready',
        publicBaseUrl: origin,
        gatherActionUrl,
        playAudioUrl: playbackAudioUrl ?? null,
      }),
    );
    const readyPlayback = this.voicePlaybackFields(Boolean(playbackAudioUrl));
    const twiml = this.finalizeTwiml(
      buildInboundGatherMvpTwiML({
        gatherActionUrl,
        language: this.getSessionLanguage(ctx),
        playbackAudioUrl,
        finalFallbackAudioUrl,
        openingSayText: strictElevenLabsOnly || playbackAudioUrl ? undefined : job.assistantResponse,
        finalFallbackSayText:
          strictElevenLabsOnly || finalFallbackAudioUrl ? undefined : playbackAudioUrl ? undefined : gatherFallbackText,
        timeoutSeconds: deferredGatherTiming.timeoutSeconds,
        speechTimeout: deferredGatherTiming.speechTimeout,
        pauseBeforeListenSeconds: deferredGatherTiming.pauseBeforeListenSeconds,
        blockTwilioSay: this.blockTwilioSay(),
      }),
      'deferred_poll_ready',
    );

    this.logTwilioResponseMetrics('deferred_poll_ready', callSessionId, handlerStartedAt);

    this.logger.log(
      JSON.stringify({
        event: 'twilio.voice.deferred_poll',
        sub: 'ready',
        callSessionId,
        playback: readyPlayback.playback,
        usedElevenLabs: job.usedElevenLabs,
        tts_generation_time_ms: job.ttsGenerationTimeMs,
        audioBytes: job.audioBytes ?? null,
        voiceProviderActuallyUsedMain: readyPlayback.voiceProviderActuallyUsed,
        voiceProviderActuallyUsedFinalFallback: finalFallbackAudioUrl
          ? resolveVoiceProviderActuallyUsed(true, this.voiceProviderPolicy())
          : undefined,
        'twilio.response_latency_ms': Date.now() - handlerStartedAt,
      }),
    );

    this.logger.log(
      JSON.stringify({
        event: 'twilio.voice.twiml_returned',
        route: 'deferred_poll_ready',
        callSessionId,
        agentResolved: true,
        twimlChars: twiml.length,
        playback: readyPlayback.playback,
        replyVerb: playbackAudioUrl ? 'Play' : 'Gather',
        voiceProviderActuallyUsed: readyPlayback.voiceProviderActuallyUsed,
        voiceProviderActuallyUsedFinalFallback: finalFallbackAudioUrl
          ? resolveVoiceProviderActuallyUsed(true, this.voiceProviderPolicy())
          : undefined,
        'twilio.response_latency_ms': Date.now() - handlerStartedAt,
      }),
    );

    return {
      twiml,
      callSessionId,
      agentResolved: true,
    };
  }

  private logTwilioResponseMetrics(route: string, callSessionId: string | undefined, startedAt: number): void {
    this.logger.log(
      JSON.stringify({
        event: 'twilio.voice.response_metrics',
        route,
        callSessionId: callSessionId ?? null,
        'twilio.response_latency_ms': Date.now() - startedAt,
      }),
    );
  }

  private kickDeferredVoiceProcessing(callSessionId: string, speechText: string, jobId: string): void {
    void this.runDeferredVoiceJob(callSessionId, speechText, jobId).catch((err) => {
      this.logger.error(
        JSON.stringify({
          event: 'voice.deferred.job_unhandled',
          callSessionId,
          jobId,
          message: err instanceof Error ? err.message.slice(0, 300) : 'unknown_error',
        }),
      );
      void this.failDeferredVoiceJobIfCurrent(
        callSessionId,
        jobId,
        err instanceof Error ? err.message.slice(0, 300) : 'unknown_error',
      );
    });
  }

  private async failDeferredVoiceJobIfCurrent(
    callSessionId: string,
    jobId: string,
    errorMessage: string,
  ): Promise<void> {
    const row = await this.callsService.findOneById(callSessionId);
    const meta =
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {};
    const cur = meta.deferredVoiceJob as DeferredVoiceJobMetadata | undefined;
    if (!cur || cur.jobId !== jobId || cur.phase !== 'processing') {
      return;
    }
    await this.callsService.mergeSessionMetadata(callSessionId, {
      deferredVoiceJob: {
        jobId,
        phase: 'failed',
        startedAtMs: cur.startedAtMs,
        errorMessage,
      },
    });
  }

  private async runDeferredVoiceJob(callSessionId: string, speechText: string, jobId: string): Promise<void> {
    const budgetRaw =
      this.config.get<string>('VOICE_DEFERRED_JOB_TIMEOUT_MS') ?? process.env.VOICE_DEFERRED_JOB_TIMEOUT_MS ?? '';
    const parsed = Number(budgetRaw.trim());
    const budgetMs = Number.isFinite(parsed)
      ? Math.min(120_000, Math.max(VOICE_DEFERRED_JOB_TIMEOUT_MS_MIN, parsed))
      : 55_000;

    try {
      await Promise.race([
        this.executeDeferredVoiceJobBody(callSessionId, speechText, jobId),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('VOICE_DEFERRED_JOB_TIMEOUT')), budgetMs),
        ),
      ]);
    } catch (err) {
      if (err instanceof Error && err.message === 'VOICE_DEFERRED_JOB_TIMEOUT') {
        this.logger.warn(
          JSON.stringify({
            event: 'voice.deferred.job_timeout',
            callSessionId,
            jobId,
            budgetMs,
            note: 'OpenAI or Shopify tools exceeded budget; failing job so deferred-poll can recover.',
          }),
        );
        await this.failDeferredVoiceJobIfCurrent(callSessionId, jobId, 'processing_timeout');
        return;
      }
      const message = err instanceof Error ? err.message.slice(0, 300) : 'unknown_error';
      this.logger.error(
        JSON.stringify({
          event: 'voice.deferred.job_fatal',
          callSessionId,
          jobId,
          message,
        }),
      );
      await this.failDeferredVoiceJobIfCurrent(callSessionId, jobId, message);
    }
  }

  private async executeDeferredVoiceJobBody(
    callSessionId: string,
    speechText: string,
    jobId: string,
  ): Promise<void> {
    const ctx = await this.sessionContext.load(callSessionId);
    if (!ctx) {
      await this.failDeferredVoiceJobIfCurrent(callSessionId, jobId, 'session_context_missing');
      return;
    }

    if (await this.streamingSession.isBargeInRequested(callSessionId)) {
      await this.failDeferredVoiceJobIfCurrent(callSessionId, jobId, 'barge_in_interrupted');
      return;
    }

    const turnStarted = Date.now();
    try {
      const llmStarted = Date.now();
      const utter = await this.voiceRuntime.processUtterance(callSessionId, speechText, []);
      const llmLatencyMs = Date.now() - llmStarted;
      const assistantResponse = utter.reply;
      const proof = utter.turnProof as Record<string, unknown> | undefined;
      await this.streamMetrics.merge(callSessionId, {
        llmLatencyMs,
        streamingStatus: 'processing',
        toolLatencyMs:
          typeof proof?.responseDelayMs === 'number' ? (proof.responseDelayMs as number) : llmLatencyMs,
      });
      if (typeof proof?.openaiUsed === 'boolean') {
        await this.voiceCost.recordOpenAiUsage(callSessionId, {
          promptTokens: 800,
          completionTokens: Math.ceil(assistantResponse.length / 4),
        });
      }
      this.logger.log(
        JSON.stringify({
          event: 'twilio.voice.llm_reply_generated',
          eventJourney: 'voice.journey.twilio_llm_reply_ready',
          callSessionId,
          tenantId: ctx.tenantId,
          replyChars: assistantResponse.length,
          turnProof: utter.turnProof ?? null,
          deferredJobId: jobId,
        }),
      );

      if (await this.streamingSession.isBargeInRequested(callSessionId)) {
        await this.failDeferredVoiceJobIfCurrent(callSessionId, jobId, 'barge_in_interrupted');
        return;
      }

      const origin = this.getPublicBaseUrl();
      const voiceOpts = {
        callSessionId,
        tenantId: ctx.tenantId,
        phase: 'gather_reply' as const,
        voiceId: this.resolveElevenLabsVoiceId(ctx.agent),
        elevenlabsApiKey: ctx.agent.elevenlabsApiKey ?? undefined,
        elevenlabsModel: ctx.agent.elevenlabsModel ?? undefined,
        isOrchestratorFinalReply: true,
      };
      const ttsStart = Date.now();
      const tts = await this.buildElevenLabsPlaybackUrl(origin, assistantResponse, voiceOpts);
      const ttsGenerationTimeMs = tts.tts_generation_time_ms ?? Date.now() - ttsStart;
      await this.voiceCost.recordElevenLabsUsage(callSessionId, assistantResponse.length);
      const totalVoiceTurnLatencyMs = Date.now() - turnStarted;
      await this.streamMetrics.merge(callSessionId, {
        ttsLatencyMs: ttsGenerationTimeMs,
        totalVoiceTurnLatencyMs,
        chunksEmitted: 1,
        streamingStatus: 'speaking',
        agentSpeaking: true,
      });
      this.logger.log(
        JSON.stringify({
          event: 'voice.turn.latency',
          callSessionId,
          jobId,
          llmLatencyMs,
          ttsGenerationTimeMs,
          totalVoiceTurnLatencyMs,
          fastMode: isVoiceCommerceFastMode(),
        }),
      );

      const row = await this.callsService.findOneById(callSessionId);
      const meta =
        row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {};
      const cur = meta.deferredVoiceJob as DeferredVoiceJobMetadata | undefined;
      if (!cur || cur.jobId !== jobId || cur.phase !== 'processing') {
        this.logger.warn(
          JSON.stringify({
            event: 'voice.deferred.stale_completion',
            callSessionId,
            jobId,
          }),
        );
        return;
      }

      await this.callsService.mergeSessionMetadata(callSessionId, {
        ...buildLlmReplyMetadataPatch(assistantResponse),
        deferredVoiceJob: {
          jobId,
          phase: 'ready',
          startedAtMs: cur.startedAtMs,
          momentPromptPlayed: cur.momentPromptPlayed,
          assistantResponse,
          playbackUrl: tts.playbackUrl,
          usedElevenLabs: Boolean(tts.playbackUrl),
          audioBytes: tts.audioBytes,
          ttsGenerationTimeMs,
          streamingEnabled: true,
        },
      });
      await this.streamingSession.clearBargeIn(callSessionId);

      const responseDelayMs = Date.now() - cur.startedAtMs;
      const fillerUsedLog = meta.fillerUsed === true;
      this.logger.log(
        JSON.stringify({
          event: 'voice.deferred.job_ready',
          callSessionId,
          jobId,
          tts_generation_time_ms: ttsGenerationTimeMs,
          usedElevenLabs: Boolean(tts.playbackUrl),
          audioBytes: tts.audioBytes ?? null,
          responseDelayMs,
          fillerUsed: fillerUsedLog,
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 300) : 'unknown_error';
      this.logger.error(
        JSON.stringify({
          event: 'twilio.voice.llm_reply_failed',
          callSessionId,
          jobId,
          message,
          deferred: true,
        }),
      );
      const stall = stallAcknowledgement(
        message.includes('timeout') ? 'processing_timeout' : 'openai_slow',
      );
      await this.callsService.mergeSessionMetadata(callSessionId, {
        lastStallPhrase: stall,
      });
      await this.failDeferredVoiceJobIfCurrent(callSessionId, jobId, message);
    }
  }

  private resolveElevenLabsVoiceId(agent: {
    voiceProvider?: string | null;
    voiceId?: string | null;
  }): string | undefined {
    void agent.voiceProvider;
    const vid = agent.voiceId?.trim();
    if (!vid) return undefined;
    return vid;
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(fallback), ms);
      promise
        .then((v) => {
          clearTimeout(t);
          resolve(v);
        })
        .catch(() => {
          clearTimeout(t);
          resolve(fallback);
        });
    });
  }

  /**
   * ElevenLabs API key: same precedence as SessionContextService (agent → tenant → env).
   */
  private async resolveElevenLabsApiKeyAndSource(
    tenantId: string,
    secretsEnc: string | null | undefined,
    agentId?: string,
  ): Promise<{
    apiKey?: string;
    keySource: 'agent' | 'tenant' | 'env' | 'none';
  }> {
    let agentPlain: string | null = null;
    if (secretsEnc && this.encryption.isAvailable()) {
      const dec = this.encryption.decryptFromStorage(secretsEnc);
      if (dec) {
        try {
          const secrets = JSON.parse(dec) as { elevenlabsApiKey?: string };
          agentPlain = typeof secrets.elevenlabsApiKey === 'string' ? secrets.elevenlabsApiKey : null;
        } catch {
          /* ignore */
        }
      }
    }

    const ti = this.encryption.isAvailable()
      ? await this.prisma.tenantIntegration.findUnique({
          where: { tenantId },
          select: { elevenlabsApiKeyEnc: true },
        })
      : null;

    const workspaceFlags = await this.loadAgentWorkspaceFlags(agentId);
    const r = resolveElevenLabsKeyChain({
      agentSecretPlain: agentPlain,
      tenantEnc: ti?.elevenlabsApiKeyEnc ?? null,
      decryptFromStorage: (s) => this.encryption.decryptFromStorage(s),
      envPlain: gatedProcessEnv('ELEVENLABS_API_KEY', this.config),
      encryptionAvailable: this.encryption.isAvailable(),
      useWorkspaceElevenlabs: workspaceFlags.useWorkspaceElevenlabs,
    });

    return { apiKey: r.value ?? undefined, keySource: r.source };
  }

  /** Resolve ElevenLabs key/model/voice for inbound greeting (before CallSession context exists). */
  private async loadElevenLabsTtsOptions(context: ResolvedAgentContext): Promise<{
    apiKey?: string;
    model?: string;
    voiceId?: string;
    keySource: 'agent' | 'tenant' | 'env' | 'none';
  }> {
    let model: string | undefined;

    const row = await this.prisma.agent.findUnique({
      where: { id: context.agentId },
      select: {
        secretsEnc: true,
        voiceId: true,
        voiceProvider: true,
        voiceProfile: { select: { providerConfig: true } },
      },
    });

    const { apiKey: elevenlabsApiKey, keySource } = await this.resolveElevenLabsApiKeyAndSource(
      context.tenantId,
      row?.secretsEnc,
      context.agentId,
    );

    if (this.encryption.isAvailable()) {
      const ti = await this.prisma.tenantIntegration.findUnique({
        where: { tenantId: context.tenantId },
        select: {
          elevenlabsDefaultModel: true,
        },
      });
      if (ti?.elevenlabsDefaultModel?.trim()) model = ti.elevenlabsDefaultModel.trim();
    }

    const pc = row?.voiceProfile?.providerConfig as { elevenlabsModel?: string } | null;
    if (pc?.elevenlabsModel?.trim()) model = pc.elevenlabsModel.trim();

    const voiceId = row?.voiceId?.trim() || undefined;

    return { apiKey: elevenlabsApiKey, model, voiceId, keySource };
  }

  private async buildElevenLabsPlaybackUrl(
    publicOrigin: string,
    text: string,
    opts: {
      callSessionId: string;
      tenantId: string;
      phase: 'inbound_greeting' | 'gather_reply';
      voiceId?: string;
      elevenlabsApiKey?: string;
      elevenlabsModel?: string;
      /** When true, this text is the orchestrator final reply for the turn. */
      isOrchestratorFinalReply?: boolean;
    },
  ): Promise<{
    playbackUrl?: string;
    audioBytes?: number;
    tts_generation_time_ms?: number;
  }> {
    const trimmed = text.trim();
    if (opts.phase !== 'inbound_greeting' && !opts.isOrchestratorFinalReply) {
      const sessionRow = await this.callsService.findOneById(opts.callSessionId);
      const sessionMeta =
        sessionRow.metadata && typeof sessionRow.metadata === 'object' && !Array.isArray(sessionRow.metadata)
          ? (sessionRow.metadata as Record<string, unknown>)
          : {};
      const blocked = shouldBlockNonOrchestratorTts({
        metadata: sessionMeta,
        candidateText: trimmed,
        sourceFunction: `buildElevenLabsPlaybackUrl:${opts.phase}`,
      });
      if (blocked) {
        this.logHiddenReplyDetected({
          callSessionId: opts.callSessionId,
          text: blocked.text,
          sourceFunction: blocked.sourceFunction,
          reason: blocked.reason,
        });
        return {};
      }
    }

    const hasBaseUrl = /^https:\/\//i.test(publicOrigin);
    const elevenLabsApiKeySet = Boolean((opts.elevenlabsApiKey ?? this.config.get<string>('ELEVENLABS_API_KEY') ?? '').trim());
    if (!hasBaseUrl || !elevenLabsApiKeySet) {
      this.logger.log(
        JSON.stringify({
          event: 'twilio.voice.tts_fallback',
          phase: opts.phase,
          callSessionId: opts.callSessionId,
          reason: !hasBaseUrl ? 'public_webhook_base_url_not_https' : 'elevenlabs_api_key_missing',
        }),
      );
      return {};
    }

    const ttsStart = Date.now();
    try {
      const speechText = prepareVoiceTtsInputText(text);
      if (!speechText) {
        this.logger.warn(
          JSON.stringify({
            event: 'voice.tts.fallback_used',
            phase: opts.phase,
            callSessionId: opts.callSessionId,
            reason: 'empty_tts_input',
          }),
        );
        return {};
      }

      this.logger.log(
        JSON.stringify({
          event: 'voice.tts_text_prepared',
          phase: opts.phase,
          callSessionId: opts.callSessionId,
          ttsInputChars: speechText.length,
        }),
      );

      const ttsOpts = {
        apiKey: opts.elevenlabsApiKey,
        modelId: opts.elevenlabsModel,
      };
      let audio = await this.elevenLabs.textToSpeech(speechText, opts.voiceId, ttsOpts);
      let validation = validateTtsAudioBuffer(audio);
      if (!validation.valid && this.voiceProviderPolicy().twilioSayBlocked) {
        audio = await this.elevenLabs.textToSpeech(speechText, opts.voiceId, ttsOpts);
        validation = validateTtsAudioBuffer(audio);
      }
      const tts_generation_time_ms = Date.now() - ttsStart;
      if (!validation.valid) {
        this.logger.warn(
          JSON.stringify({
            event: 'voice.tts.fallback_used',
            phase: opts.phase,
            callSessionId: opts.callSessionId,
            reason: validation.reason ?? 'invalid_audio',
            audioBytes: audio.length,
            tts_generation_time_ms,
          }),
        );
        return { audioBytes: audio.length, tts_generation_time_ms };
      }

      const token = this.ttsCache.put(audio);
      const playbackUrl = buildTtsPlaybackUrl(publicOrigin, token);

      this.logger.log(
        JSON.stringify({
          event: 'voice.tts.playback_ready',
          provider: 'elevenlabs',
          phase: opts.phase,
          callSessionId: opts.callSessionId,
          audioBytes: audio.length,
          playbackUrl,
          contentType: validation.contentType,
          ttsInputChars: speechText.length,
          tts_generation_time_ms,
        }),
      );

      this.logger.log(
        JSON.stringify({
          event: 'twilio.voice.elevenlabs_audio_generated',
          phase: opts.phase,
          callSessionId: opts.callSessionId,
          audioBytes: audio.length,
          ttsInputChars: speechText.length,
          tts_generation_time_ms,
        }),
      );
      return { playbackUrl, audioBytes: audio.length, tts_generation_time_ms };
    } catch (err) {
      const tts_generation_time_ms = Date.now() - ttsStart;
      const message = err instanceof Error ? err.message.slice(0, 300) : 'unknown_error';
      this.logger.warn(
        JSON.stringify({
          event: 'voice.tts.fallback_used',
          phase: opts.phase,
          callSessionId: opts.callSessionId,
          reason: 'elevenlabs_request_failed',
          message,
          tts_generation_time_ms,
        }),
      );
      await this.callEvents.log(opts.tenantId, opts.callSessionId, CallEventType.FALLBACK_USED, {
        reason: 'elevenlabs_tts_failed',
        phase: opts.phase,
        message,
      });
      return { tts_generation_time_ms };
    }
  }
}
