import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import {
  createRedisClient,
  resolveRedisUrlFromConfig,
  safeRedisGet,
  safeRedisSetex,
} from '../../common/redis-client.util';
import type { VoiceCatalogProduct } from '../shopify/types/voice-product.types';

const DEFAULT_TTL_SEC = 60;
const MEMORY_MAX_ENTRIES = 500;

type CachePayload = {
  products: VoiceCatalogProduct[];
  cachedAt: string;
};

@Injectable()
export class VoiceProductCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(VoiceProductCacheService.name);
  private readonly memory = new Map<string, { expiresAt: number; payload: CachePayload }>();
  private redis: Redis | null = null;
  private readonly ttlSec: number;

  constructor(private readonly config: ConfigService) {
    this.ttlSec =
      Number(this.config.get<string>('VOICE_SEARCH_CACHE_TTL_SEC')) || DEFAULT_TTL_SEC;
    const url = resolveRedisUrlFromConfig((k) => this.config.get<string>(k));
    if (url) {
      const { client } = createRedisClient(url, this.logger, 'VoiceProductCacheService');
      this.redis = client;
    }
  }

  onModuleDestroy(): void {
    void this.redis?.quit().catch(() => undefined);
  }

  cacheKey(tenantId: string, agentId: string, query: string): string {
    const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
    return `voice:search:v2:${tenantId}:${agentId}:${normalized}`;
  }

  async get(key: string): Promise<VoiceCatalogProduct[] | null> {
    const fromRedis = await this.readRedis(key);
    if (fromRedis) return fromRedis;

    const mem = this.memory.get(key);
    if (!mem) return null;
    if (Date.now() > mem.expiresAt) {
      this.memory.delete(key);
      return null;
    }
    return mem.payload.products;
  }

  async set(key: string, products: VoiceCatalogProduct[]): Promise<void> {
    const payload: CachePayload = { products, cachedAt: new Date().toISOString() };
    const serialized = JSON.stringify(payload);

    const redisOk = await safeRedisSetex(this.redis, key, this.ttlSec, serialized);
    if (!redisOk) {
      this.evictMemoryIfNeeded();
      this.memory.set(key, {
        expiresAt: Date.now() + this.ttlSec * 1000,
        payload,
      });
    }
  }

  private async readRedis(key: string): Promise<VoiceCatalogProduct[] | null> {
    const raw = await safeRedisGet(this.redis, key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as CachePayload;
      return Array.isArray(parsed.products) ? parsed.products : null;
    } catch {
      return null;
    }
  }

  private evictMemoryIfNeeded(): void {
    if (this.memory.size < MEMORY_MAX_ENTRIES) return;
    const oldest = this.memory.keys().next().value;
    if (oldest) this.memory.delete(oldest);
  }
}
