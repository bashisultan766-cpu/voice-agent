import { Logger } from '@nestjs/common';

const perfLogger = new Logger('VoiceTurnPerformance');

const SLOW_TURN_MS = Number(process.env.VOICE_SLOW_TURN_MS) || 2000;

export type VoiceTurnPerformanceSnapshot = {
  callSessionId: string;
  tenantId?: string;
  agentId?: string;
  totalTurnLatencyMs: number;
  intentLatencyMs?: number;
  openaiLatencyMs?: number;
  shopifyLatencyMs?: number;
  ttsLatencyMs?: number;
  cacheHit?: boolean;
  instantReplyUsed?: boolean;
  openaiCalled?: boolean;
  slowPathReason?: string | null;
};

export function logVoiceTurnPerformance(snapshot: VoiceTurnPerformanceSnapshot): void {
  perfLogger.log(
    JSON.stringify({
      event: 'voice.turn.performance',
      totalTurnLatencyMs: snapshot.totalTurnLatencyMs,
      intentLatencyMs: snapshot.intentLatencyMs ?? null,
      openaiLatencyMs: snapshot.openaiLatencyMs ?? null,
      shopifyLatencyMs: snapshot.shopifyLatencyMs ?? null,
      ttsLatencyMs: snapshot.ttsLatencyMs ?? null,
      cacheHit: snapshot.cacheHit ?? false,
      instantReplyUsed: snapshot.instantReplyUsed ?? false,
      openaiCalled: snapshot.openaiCalled ?? true,
      slowPathReason: snapshot.slowPathReason ?? null,
      callSessionId: snapshot.callSessionId,
      tenantId: snapshot.tenantId ?? null,
      agentId: snapshot.agentId ?? null,
    }),
  );

  if (snapshot.totalTurnLatencyMs >= SLOW_TURN_MS) {
    const bottleneck =
      snapshot.slowPathReason ??
      (snapshot.openaiLatencyMs && snapshot.openaiLatencyMs > 800
        ? 'openai'
        : snapshot.shopifyLatencyMs && snapshot.shopifyLatencyMs > 600
          ? 'shopify'
          : snapshot.ttsLatencyMs && snapshot.ttsLatencyMs > 400
            ? 'tts'
            : 'unknown');

    perfLogger.warn(
      JSON.stringify({
        event: 'voice.slow_turn',
        callSessionId: snapshot.callSessionId,
        totalTurnLatencyMs: snapshot.totalTurnLatencyMs,
        bottleneck,
        intentLatencyMs: snapshot.intentLatencyMs ?? null,
        openaiLatencyMs: snapshot.openaiLatencyMs ?? null,
        shopifyLatencyMs: snapshot.shopifyLatencyMs ?? null,
        ttsLatencyMs: snapshot.ttsLatencyMs ?? null,
        instantReplyUsed: snapshot.instantReplyUsed ?? false,
        cacheHit: snapshot.cacheHit ?? false,
      }),
    );
  }
}
