import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallsService } from '../calls/calls.service';
import { VoicePromptAudioService } from '../integrations/twilio/voice-prompt-audio.service';
import { normalizePreparedVoiceText } from '../voice-intent-pipeline/voice-summarizer.util';
import { compressForVoice } from './voice-text-compressor.util';
import {
  canMakeElevenLabsApiCall,
  markTtsApiCallUsedPatch,
} from './voice-tts-session-guard.util';
import type { VoiceTtsPlaybackResult } from './types/voice-controlled-response.types';

export type VoiceTtsGatewayArgs = {
  publicOrigin: string;
  text: string;
  voiceId: string;
  apiKey?: string;
  modelId?: string;
  callSessionId: string;
  phase: string;
  /** When true, this is the one allowed ElevenLabs API call for the turn. */
  isOrchestratorFinalReply?: boolean;
  /** Never call ElevenLabs API — cache or Twilio Say only. */
  cacheOnly?: boolean;
  allowTwilioSayFallback?: boolean;
  /** When true, text is already pipeline voice_text — do not re-compress. */
  preparedVoiceText?: boolean;
};

/**
 * Unified TTS gateway: compress → cache → single API call → Twilio Say fallback.
 * Reuses existing memory/Redis/disk audio cache in VoicePromptAudioService.
 */
@Injectable()
export class VoiceTtsGatewayService {
  private readonly logger = new Logger(VoiceTtsGatewayService.name);
  private quotaExceededUntilMs = 0;

  constructor(
    private readonly voicePromptAudio: VoicePromptAudioService,
    private readonly callsService: CallsService,
    private readonly config: ConfigService,
  ) {}

  isQuotaBlocked(): boolean {
    return Date.now() < this.quotaExceededUntilMs;
  }

  private markQuotaExceeded(errText: string): void {
    if (/quota|rate.?limit|429|402|insufficient/i.test(errText)) {
      const cooldownSec = Number(this.config.get<string>('VOICE_TTS_QUOTA_COOLDOWN_SEC') ?? 120);
      this.quotaExceededUntilMs = Date.now() + cooldownSec * 1000;
      this.logger.warn(
        JSON.stringify({
          event: 'voice.tts.quota_cooldown',
          cooldownSec,
        }),
      );
    }
  }

  async synthesizeForPlayback(args: VoiceTtsGatewayArgs): Promise<VoiceTtsPlaybackResult> {
    const voiceText = args.preparedVoiceText
      ? normalizePreparedVoiceText(args.text)
      : compressForVoice(args.text.replace(/\s+/g, ' ').trim());
    const empty: VoiceTtsPlaybackResult = {
      voiceText: '',
      ttsGenerated: false,
      audioCacheHit: false,
      elevenlabsApiCallUsed: false,
    };
    if (!voiceText) return empty;

    const sessionRow = await this.callsService.findOneById(args.callSessionId);
    const sessionMeta =
      sessionRow.metadata && typeof sessionRow.metadata === 'object' && !Array.isArray(sessionRow.metadata)
        ? (sessionRow.metadata as Record<string, unknown>)
        : {};

    const modelId = this.voicePromptAudio.resolveLatencyModelId(args.modelId);
    const cached = await this.voicePromptAudio.resolveCachedPhrasePlaybackUrl(args.publicOrigin, {
      text: voiceText,
      voiceId: args.voiceId,
      modelId,
      callSessionId: args.callSessionId,
    });

    if (cached.playbackUrl) {
      return {
        playbackUrl: cached.playbackUrl,
        voiceText,
        ttsGenerated: false,
        audioCacheHit: true,
        elevenlabsApiCallUsed: false,
        ttsLatencyMs: 0,
        elevenlabsModel: modelId,
        audioCacheKey: cached.audioCacheKey,
      };
    }

    const allowApi =
      !args.cacheOnly &&
      !this.isQuotaBlocked() &&
      canMakeElevenLabsApiCall({
        metadata: sessionMeta,
        isOrchestratorFinalReply: args.isOrchestratorFinalReply,
        cacheHit: false,
      });

    if (!allowApi) {
      const reason = args.cacheOnly
        ? 'cache_only_miss'
        : this.isQuotaBlocked()
          ? 'elevenlabs_quota_cooldown'
          : 'single_tts_rule_blocked';
      if (args.allowTwilioSayFallback !== false) {
        return {
          twilioSayText: voiceText,
          voiceText,
          ttsGenerated: false,
          audioCacheHit: false,
          elevenlabsApiCallUsed: false,
          fallbackReason: reason,
        };
      }
      return { ...empty, voiceText, fallbackReason: reason };
    }

    const apiKey =
      args.apiKey?.trim() || this.config.get<string>('ELEVENLABS_API_KEY')?.trim() || undefined;
    if (!apiKey) {
      return {
        twilioSayText: args.allowTwilioSayFallback !== false ? voiceText : undefined,
        voiceText,
        ttsGenerated: false,
        audioCacheHit: false,
        elevenlabsApiCallUsed: false,
        fallbackReason: 'elevenlabs_api_key_missing',
      };
    }

    try {
      const result = await this.voicePromptAudio.createPhrasePlaybackUrl(args.publicOrigin, {
        text: voiceText,
        voiceId: args.voiceId,
        apiKey,
        modelId,
        callSessionId: args.callSessionId,
      });

      if (result.playbackUrl) {
        if (result.ttsGenerated) {
          await this.callsService.mergeSessionMetadata(
            args.callSessionId,
            markTtsApiCallUsedPatch(voiceText),
          );
        }
        return {
          playbackUrl: result.playbackUrl,
          voiceText,
          ttsGenerated: result.ttsGenerated,
          audioCacheHit: result.audioCacheHit ?? false,
          elevenlabsApiCallUsed: result.ttsGenerated,
          ttsLatencyMs: result.ttsLatencyMs,
          elevenlabsModel: result.elevenlabsModel,
          audioCacheKey: result.audioCacheKey,
        };
      }

      return {
        twilioSayText: args.allowTwilioSayFallback !== false ? voiceText : undefined,
        voiceText,
        ttsGenerated: false,
        audioCacheHit: false,
        elevenlabsApiCallUsed: false,
        fallbackReason: 'elevenlabs_playback_failed',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.markQuotaExceeded(message);
      this.logger.warn(
        JSON.stringify({
          event: 'voice.tts.gateway_failed',
          phase: args.phase,
          callSessionId: args.callSessionId,
          message: message.slice(0, 200),
        }),
      );
      return {
        twilioSayText: args.allowTwilioSayFallback !== false ? voiceText : undefined,
        voiceText,
        ttsGenerated: false,
        audioCacheHit: false,
        elevenlabsApiCallUsed: false,
        fallbackReason: 'elevenlabs_request_failed',
      };
    }
  }
}
