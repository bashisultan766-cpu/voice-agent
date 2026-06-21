import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import Redis from 'ioredis';
import {
  createRedisClient,
  resolveRedisUrlFromConfig,
  safeRedisGet,
  safeRedisSetex,
} from '../../common/redis-client.util';
import type { IntentAnalysisResult, OrchestratedVoiceResponse } from './types/intent-analysis.types';

const INTENT_CACHE_PREFIX = 'voice:intent-cache:';
const RESPONSE_CACHE_PREFIX = 'voice:response-cache:';
const DEFAULT_INTENT_TTL = 90;
const DEFAULT_RESPONSE_TTL = 180;

type CachedResponse = Pick<OrchestratedVoiceResponse, 'text_response' | 'voice_text' | 'actions_executed'>;

/**
 * Redis caches to skip repeat OpenAI intent + orchestration for identical utterances.
 */
@Injectable()
export class VoiceResponseCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(VoiceResponseCacheService.name);
  private readonly intentFallback = new Map<string, IntentAnalysisResult>();
  private readonly responseFallback = new Map<string, CachedResponse>();
  private redis: Redis | null = null;
  private readonly intentTtlSec: number;
  private readonly responseTtlSec: number;

  constructor(private readonly config: ConfigService) {
    const url = resolveRedisUrlFromConfig((k) => this.config.get<string>(k));
    if (url) {
      const { client } = createRedisClient(url, this.logger, 'VoiceResponseCache');
      this.redis = client;
    }
    this.intentTtlSec = Number(this.config.get('VOICE_INTENT_CACHE_TTL_SEC')) || DEFAULT_INTENT_TTL;
    this.responseTtlSec = Number(this.config.get('VOICE_RESPONSE_CACHE_TTL_SEC')) || DEFAULT_RESPONSE_TTL;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) await this.redis.quit().catch(() => undefined);
  }

  private hash(text: string): string {
    return createHash('sha256').update(text.trim()).digest('hex').slice(0, 32);
  }

  async getIntent(message: string): Promise<IntentAnalysisResult | null> {
    const key = `${INTENT_CACHE_PREFIX}${this.hash(message)}`;
    const raw = await safeRedisGet(this.redis, key);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as IntentAnalysisResult;
        return { ...parsed, source: 'cache' };
      } catch {
        return null;
      }
    }
    return this.intentFallback.get(key) ?? null;
  }

  async setIntent(message: string, intent: IntentAnalysisResult): Promise<void> {
    const key = `${INTENT_CACHE_PREFIX}${this.hash(message)}`;
    const payload = JSON.stringify({ ...intent, source: 'openai' });
    const ok = await safeRedisSetex(this.redis, key, this.intentTtlSec, payload);
    if (!ok) this.intentFallback.set(key, intent);
  }

  async getResponse(callSessionId: string, message: string): Promise<CachedResponse | null> {
    const key = `${RESPONSE_CACHE_PREFIX}${callSessionId}:${this.hash(message)}`;
    const raw = await safeRedisGet(this.redis, key);
    if (raw) {
      try {
        return JSON.parse(raw) as CachedResponse;
      } catch {
        return null;
      }
    }
    return this.responseFallback.get(key) ?? null;
  }

  async setResponse(callSessionId: string, message: string, response: CachedResponse): Promise<void> {
    const key = `${RESPONSE_CACHE_PREFIX}${callSessionId}:${this.hash(message)}`;
    const ok = await safeRedisSetex(this.redis, key, this.responseTtlSec, JSON.stringify(response));
    if (!ok) this.responseFallback.set(key, response);
  }
}
