import { Logger } from '@nestjs/common';

const perfLogger = new Logger('VoiceLatencyBreakdown');

export type VoiceLatencyRootCause =
  | 'tts'
  | 'openai'
  | 'shopify'
  | 'db'
  | 'twilio'
  | 'normalization'
  | 'redis'
  | 'tools'
  | 'unknown';

export type VoiceLatencyBreakdown = {
  callSessionId?: string;
  tenantId?: string;
  agentId?: string;
  route?: string;
  twilioReceiveMs?: number;
  speechToRuntimeMs?: number;
  normalizationMs?: number;
  intentDetectionMs?: number;
  languageDetectionMs?: number;
  instantReplyMs?: number;
  openaiMs?: number;
  toolMs?: number;
  shopifyMs?: number;
  dbMs?: number;
  redisMs?: number;
  ttsMs?: number;
  twilioTwimlReturnMs?: number;
  totalCallerWaitMs?: number;
  instantReplyUsed?: boolean;
  openaiCalled?: boolean;
  ttsGenerated?: boolean;
  audioCacheHit?: boolean;
  shopifySkipped?: boolean;
  openaiSkippedReason?: string | null;
  elevenlabsModel?: string | null;
  elevenlabsLatencyMs?: number | null;
  audioCacheKey?: string | null;
};

const SLA_WARN_MS = Number(process.env.VOICE_SLA_WARN_MS) || 1000;
const SLA_FAIL_MS = Number(process.env.VOICE_SLA_FAIL_MS) || 2000;

export function resolveVoiceLatencyRootCause(b: VoiceLatencyBreakdown): VoiceLatencyRootCause {
  const entries: Array<[VoiceLatencyRootCause, number]> = [
    ['tts', b.ttsMs ?? b.elevenlabsLatencyMs ?? 0],
    ['openai', b.openaiMs ?? 0],
    ['shopify', b.shopifyMs ?? 0],
    ['db', b.dbMs ?? 0],
    ['redis', b.redisMs ?? 0],
    ['normalization', b.normalizationMs ?? 0],
    ['tools', b.toolMs ?? 0],
    ['twilio', b.twilioTwimlReturnMs ?? 0],
  ];
  entries.sort((a, c) => c[1] - a[1]);
  const top = entries[0];
  if (!top || top[1] <= 0) {
    if (b.instantReplyUsed && (b.totalCallerWaitMs ?? 0) > SLA_WARN_MS) return 'db';
    return 'unknown';
  }
  return top[0];
}

export function logVoiceLatencyBreakdown(b: VoiceLatencyBreakdown): void {
  const total = b.totalCallerWaitMs ?? 0;
  const rootCause = resolveVoiceLatencyRootCause(b);

  perfLogger.log(
    JSON.stringify({
      event: 'voice.latency.breakdown',
      ...b,
      rootCause,
    }),
  );

  if (total >= SLA_WARN_MS) {
    perfLogger.warn(
      JSON.stringify({
        event: 'voice.slow_turn_root_cause',
        callSessionId: b.callSessionId,
        totalCallerWaitMs: total,
        rootCause,
        ttsMs: b.ttsMs ?? null,
        openaiMs: b.openaiMs ?? null,
        shopifyMs: b.shopifyMs ?? null,
        dbMs: b.dbMs ?? null,
        normalizationMs: b.normalizationMs ?? null,
        instantReplyUsed: b.instantReplyUsed ?? false,
        audioCacheHit: b.audioCacheHit ?? false,
      }),
    );
  }

  if (total >= SLA_FAIL_MS) {
    perfLogger.error(
      JSON.stringify({
        event: 'voice.sla_failed',
        callSessionId: b.callSessionId,
        totalCallerWaitMs: total,
        rootCause,
        slaWarnMs: SLA_WARN_MS,
        slaFailMs: SLA_FAIL_MS,
      }),
    );
  }
}

export class VoiceLatencyTimer {
  private readonly startedAt = Date.now();
  private readonly marks = new Map<string, number>();
  private readonly sectionStarts = new Map<string, number>();

  mark(label: string, ms: number): void {
    this.marks.set(label, ms);
  }

  elapsed(): number {
    return Date.now() - this.startedAt;
  }

  startSection(label: string): void {
    this.sectionStarts.set(label, Date.now());
  }

  endSection(label: string): number {
    const t0 = this.sectionStarts.get(label) ?? this.startedAt;
    const ms = Date.now() - t0;
    this.marks.set(label, ms);
    return ms;
  }

  toBreakdown(base: Partial<VoiceLatencyBreakdown>): VoiceLatencyBreakdown {
    const get = (k: string) => this.marks.get(k);
    return {
      ...base,
      twilioReceiveMs: get('twilioReceiveMs') ?? base.twilioReceiveMs,
      speechToRuntimeMs: get('speechToRuntimeMs') ?? base.speechToRuntimeMs,
      normalizationMs: get('normalizationMs') ?? base.normalizationMs,
      intentDetectionMs: get('intentDetectionMs') ?? base.intentDetectionMs,
      languageDetectionMs: get('languageDetectionMs') ?? base.languageDetectionMs,
      instantReplyMs: get('instantReplyMs') ?? base.instantReplyMs,
      openaiMs: get('openaiMs') ?? base.openaiMs,
      toolMs: get('toolMs') ?? base.toolMs,
      shopifyMs: get('shopifyMs') ?? base.shopifyMs,
      dbMs: get('dbMs') ?? base.dbMs,
      redisMs: get('redisMs') ?? base.redisMs,
      ttsMs: get('ttsMs') ?? base.ttsMs,
      twilioTwimlReturnMs: this.elapsed(),
      totalCallerWaitMs: this.elapsed(),
    };
  }
}
