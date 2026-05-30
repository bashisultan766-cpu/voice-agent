import { Injectable } from '@nestjs/common';
import {
  logVoiceLatencyBreakdown,
  resolveVoiceLatencyRootCause,
  VoiceLatencyTimer,
  type VoiceLatencyBreakdown,
  type VoiceLatencyRootCause,
} from './voice-latency-breakdown.util';

/** Structured voice turn latency instrumentation and SLA enforcement. */
@Injectable()
export class VoiceLatencyAnalyzerService {
  createTimer(): VoiceLatencyTimer {
    return new VoiceLatencyTimer();
  }

  resolveRootCause(breakdown: VoiceLatencyBreakdown): VoiceLatencyRootCause {
    return resolveVoiceLatencyRootCause(breakdown);
  }

  recordBreakdown(breakdown: VoiceLatencyBreakdown): VoiceLatencyRootCause {
    logVoiceLatencyBreakdown(breakdown);
    return resolveVoiceLatencyRootCause(breakdown);
  }

  buildDeferredBreakdown(args: {
    callSessionId: string;
    tenantId?: string;
    agentId?: string;
    jobStartedAtMs: number;
    llmLatencyMs: number;
    ttsGenerationTimeMs: number;
    turnProof?: Record<string, unknown>;
    audioCacheHit?: boolean;
    audioServedFromCache?: boolean;
    elevenlabsModel?: string | null;
  }): VoiceLatencyBreakdown {
    const proof = args.turnProof ?? {};
    const openaiCalled = proof.openaiCalled === true || proof.openaiUsed === true;
    const openaiSkippedReason =
      typeof proof.openaiSkippedReason === 'string'
        ? proof.openaiSkippedReason
        : proof.skipOpenAiGeneration === true
          ? 'transactional_checkout_state'
          : proof.instant_reply_used === true
            ? 'instant_deterministic_reply'
            : null;

    const totalCallerWaitMs = Date.now() - args.jobStartedAtMs;
    const openaiMs =
      typeof proof.openaiLatencyMs === 'number'
        ? (proof.openaiLatencyMs as number)
        : openaiCalled
          ? args.llmLatencyMs
          : 0;
    const intentLatencyMs =
      typeof proof.intentLatencyMs === 'number' ? (proof.intentLatencyMs as number) : undefined;

    return {
      callSessionId: args.callSessionId,
      tenantId: args.tenantId,
      agentId: args.agentId,
      route: 'deferred_voice_job',
      intentDetectionMs: intentLatencyMs,
      openaiMs,
      toolMs: openaiCalled ? Math.max(0, args.llmLatencyMs - openaiMs) : 0,
      ttsMs: args.ttsGenerationTimeMs,
      totalCallerWaitMs,
      twilioTwimlReturnMs: totalCallerWaitMs,
      instantReplyUsed: proof.instant_reply_used === true,
      openaiCalled,
      ttsGenerated: !args.audioServedFromCache,
      audioCacheHit: args.audioCacheHit ?? args.audioServedFromCache ?? false,
      openaiSkippedReason,
      elevenlabsModel: args.elevenlabsModel ?? null,
      elevenlabsLatencyMs: args.ttsGenerationTimeMs,
    };
  }
}
