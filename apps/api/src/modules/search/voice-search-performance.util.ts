import { Logger } from '@nestjs/common';
import { isVoiceCommerceFastMode } from '../calls/runtime/voice-commerce-fast-mode.util';

const perfLogger = new Logger('VoiceSearchPerformance');

export interface VoiceSearchLatencySnapshot {
  searchLatencyMs: number;
  cacheHit: boolean;
  shopifyLatencyMs?: number;
  semanticRankingLatencyMs?: number;
  cacheLookupMs?: number;
  indexLoadMs?: number;
  totalVoiceTurnLatencyMs?: number;
  memoryHit?: boolean;
  redisHit?: boolean;
  slowPath?: boolean;
}

const SLOW_SEARCH_MS = Number(process.env.VOICE_SLOW_SEARCH_MS) || 2000;
const SLOW_RANKING_MS = Number(process.env.VOICE_SLOW_RANKING_MS) || 400;
const SLOW_SHOPIFY_MS = Number(process.env.VOICE_SLOW_SHOPIFY_MS) || 1500;

export function logVoiceSearchLatency(event: string, payload: VoiceSearchLatencySnapshot & Record<string, unknown>): void {
  const slowPath =
    payload.searchLatencyMs >= SLOW_SEARCH_MS ||
    (payload.semanticRankingLatencyMs ?? 0) >= SLOW_RANKING_MS ||
    (payload.shopifyLatencyMs ?? 0) >= SLOW_SHOPIFY_MS;

  perfLogger.log(
    JSON.stringify({
      event,
      fastMode: isVoiceCommerceFastMode(),
      slowPath,
      ...payload,
    }),
  );

  if (slowPath) {
    perfLogger.warn(
      JSON.stringify({
        event: 'voice.search.slow_path',
        searchLatencyMs: payload.searchLatencyMs,
        shopifyLatencyMs: payload.shopifyLatencyMs ?? null,
        semanticRankingLatencyMs: payload.semanticRankingLatencyMs ?? null,
        cacheHit: payload.cacheHit,
        memoryHit: payload.memoryHit ?? false,
        redisHit: payload.redisHit ?? false,
      }),
    );
  }
}
