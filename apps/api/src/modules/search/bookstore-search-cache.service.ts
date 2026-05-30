import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import {
  createRedisClient,
  resolveRedisUrlFromConfig,
  safeRedisGet,
  safeRedisSetex,
} from '../../common/redis-client.util';
import { isVoiceCommerceFastMode } from '../calls/runtime/voice-commerce-fast-mode.util';
import type { BookstoreVoiceSearchResult } from './types/bookstore-search.types';

const MEMORY_TTL_MS = 5 * 60 * 1000;
const REDIS_TTL_SEC = 15 * 60;
const DEBOUNCE_MS = 400;
const RECENT_SEARCH_MAX = 48;
const CATALOG_SNAPSHOT_TTL_SEC = 30 * 60;
const POPULAR_SEARCH_TTL_SEC = 7 * 24 * 60 * 60;
const POPULAR_SEARCH_MAX = 100;

interface MemoryEntry {
  expiresAt: number;
  payload: BookstoreVoiceSearchResult;
  /** Warm placeholder — never serve as a search result. */
  warmPlaceholder?: boolean;
}

export interface BookstoreCacheLookupResult {
  memory: BookstoreVoiceSearchResult | null;
  redis: BookstoreVoiceSearchResult | null;
  memoryHit: boolean;
  redisHit: boolean;
  cacheLookupMs: number;
}

@Injectable()
export class BookstoreSearchCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookstoreSearchCacheService.name);
  private redis: Redis | null = null;
  private readonly memory = new Map<string, MemoryEntry>();
  private readonly debounce = new Map<string, { at: number; key: string }>();
  private readonly recentSearches = new Map<string, string[]>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const url = resolveRedisUrlFromConfig((key: string) => this.config.get<string>(key));
    if (!url) return;
    try {
      const { client } = createRedisClient(url, this.logger, 'BookstoreSearchCacheService');
      this.redis = client;
    } catch (err) {
      this.logger.warn(
        JSON.stringify({
          event: 'redis.error',
          service: 'BookstoreSearchCacheService',
          phase: 'init',
          message: err instanceof Error ? err.message : 'unknown',
          note: 'Continuing with in-memory search cache only',
        }),
      );
      this.redis = null;
    }
  }

  onModuleDestroy(): void {
    void this.redis?.quit().catch(() => undefined);
  }

  private cacheKey(tenantId: string, agentId: string, normalizedQuery: string): string {
    return `bookstore:search:${tenantId}:${agentId}:${normalizedQuery}`;
  }

  private recentKey(tenantId: string, agentId: string): string {
    return `${tenantId}:${agentId}`;
  }

  private catalogSnapshotKey(tenantId: string, agentId: string, shopDomain: string): string {
    return `bookstore:catalog:${tenantId}:${agentId}:${shopDomain}`;
  }

  shouldDebounce(tenantId: string, agentId: string, normalizedQuery: string): boolean {
    const key = `${tenantId}:${agentId}:${normalizedQuery}`;
    const now = Date.now();
    const prev = this.debounce.get(key);
    this.debounce.set(key, { at: now, key });
    if (prev && now - prev.at < DEBOUNCE_MS) return true;
    return false;
  }

  /** Returns a real cached result only (skips warm placeholders and empty product lists). */
  getMemoryHit(
    tenantId: string,
    agentId: string,
    normalizedQuery: string,
  ): BookstoreVoiceSearchResult | null {
    const hit = this.getMemory(tenantId, agentId, normalizedQuery);
    if (!hit || !this.isServeableHit(hit)) return null;
    return hit;
  }

  getMemory(tenantId: string, agentId: string, normalizedQuery: string): BookstoreVoiceSearchResult | null {
    const key = this.cacheKey(tenantId, agentId, normalizedQuery);
    const hit = this.memory.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this.memory.delete(key);
      return null;
    }
    if (hit.warmPlaceholder) return null;
    return hit.payload;
  }

  private isServeableHit(payload: BookstoreVoiceSearchResult): boolean {
    return Boolean(payload.products?.length && (payload.voiceSummary?.trim() || payload.ok));
  }

  setMemory(
    tenantId: string,
    agentId: string,
    normalizedQuery: string,
    payload: BookstoreVoiceSearchResult,
  ): void {
    const key = this.cacheKey(tenantId, agentId, normalizedQuery);
    this.memory.set(key, { expiresAt: Date.now() + MEMORY_TTL_MS, payload });
    this.recordRecentSearch(tenantId, agentId, normalizedQuery);
  }

  /** Parallel memory + Redis lookup for voice hot path. */
  async lookupParallel(
    tenantId: string,
    agentId: string,
    normalizedQuery: string,
  ): Promise<BookstoreCacheLookupResult> {
    const started = Date.now();
    const memory = this.getMemoryHit(tenantId, agentId, normalizedQuery);
    if (memory) {
      return {
        memory,
        redis: null,
        memoryHit: true,
        redisHit: false,
        cacheLookupMs: Date.now() - started,
      };
    }
    const redis = await this.getRedis(tenantId, agentId, normalizedQuery);
    const redisHit = redis && this.isServeableHit(redis) ? redis : null;
    return {
      memory: null,
      redis: redisHit,
      memoryHit: false,
      redisHit: Boolean(redisHit),
      cacheLookupMs: Date.now() - started,
    };
  }

  async getRedis(
    tenantId: string,
    agentId: string,
    normalizedQuery: string,
  ): Promise<BookstoreVoiceSearchResult | null> {
    const raw = await safeRedisGet(this.redis, this.cacheKey(tenantId, agentId, normalizedQuery));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as BookstoreVoiceSearchResult;
      return this.isServeableHit(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async setRedis(
    tenantId: string,
    agentId: string,
    normalizedQuery: string,
    payload: BookstoreVoiceSearchResult,
  ): Promise<void> {
    await safeRedisSetex(
      this.redis,
      this.cacheKey(tenantId, agentId, normalizedQuery),
      REDIS_TTL_SEC,
      JSON.stringify(payload),
    );
  }

  recordRecentSearch(tenantId: string, agentId: string, normalizedQuery: string): void {
    const key = this.recentKey(tenantId, agentId);
    const prev = this.recentSearches.get(key) ?? [];
    const next = [normalizedQuery, ...prev.filter((q) => q !== normalizedQuery)].slice(0, RECENT_SEARCH_MAX);
    this.recentSearches.set(key, next);
  }

  /** Track popular voice queries in memory + Redis sorted set. */
  async recordPopularSearch(tenantId: string, agentId: string, normalizedQuery: string): Promise<void> {
    const q = normalizedQuery.toLowerCase().trim();
    if (!q) return;
    this.recordRecentSearch(tenantId, agentId, q);
    if (!this.redis || this.redis.status !== 'ready') return;
    try {
      const key = this.popularSearchesKey(tenantId, agentId);
      await this.redis.zincrby(key, 1, q);
      await this.redis.expire(key, POPULAR_SEARCH_TTL_SEC);
      const count = await this.redis.zcard(key);
      if (count > POPULAR_SEARCH_MAX) {
        await this.redis.zremrangebyrank(key, 0, count - POPULAR_SEARCH_MAX - 1);
      }
    } catch {
      /* non-fatal */
    }
  }

  async getPopularSearches(tenantId: string, agentId: string, limit = 20): Promise<string[]> {
    const memory = this.getRecentSearches(tenantId, agentId, limit);
    if (!this.redis || this.redis.status !== 'ready') return memory;
    try {
      const key = this.popularSearchesKey(tenantId, agentId);
      const redisHits = await this.redis.zrevrange(key, 0, limit - 1);
      const merged = [...new Set([...redisHits, ...memory])];
      return merged.slice(0, limit);
    } catch {
      return memory;
    }
  }

  private popularSearchesKey(tenantId: string, agentId: string): string {
    return `bookstore:popular:${tenantId}:${agentId}`;
  }

  getRecentSearches(tenantId: string, agentId: string, limit = 12): string[] {
    return (this.recentSearches.get(this.recentKey(tenantId, agentId)) ?? []).slice(0, limit);
  }

  async setCatalogSnapshot(
    tenantId: string,
    agentId: string,
    shopDomain: string,
    indexSize: number,
  ): Promise<void> {
    await safeRedisSetex(
      this.redis,
      this.catalogSnapshotKey(tenantId, agentId, shopDomain),
      CATALOG_SNAPSHOT_TTL_SEC,
      JSON.stringify({ indexSize, builtAt: Date.now() }),
    );
  }

  /** Marks query as in-flight warm (not returned to callers). */
  markWarmQuery(tenantId: string, agentId: string, query: string): void {
    const key = this.cacheKey(tenantId, agentId, query.toLowerCase().trim());
    this.memory.set(key, {
      expiresAt: Date.now() + MEMORY_TTL_MS * 2,
      warmPlaceholder: true,
      payload: { ok: true, products: [], voiceSummary: '' },
    });
  }

  logCacheMiss(tenantId: string, agentId: string, normalizedQuery: string): void {
    if (!isVoiceCommerceFastMode()) return;
    this.logger.debug(
      JSON.stringify({
        event: 'bookstore.search.cache_miss',
        tenantId,
        agentId,
        query: normalizedQuery.slice(0, 80),
      }),
    );
  }
}

export const POPULAR_WARM_QUERIES = [
  'Harry Potter',
  'Harry Potter and the Sorcerer\'s Stone',
  'Dark Tower',
  'The Dark Tower',
  'Atomic Habits',
  'Rich Dad Poor Dad',
  'Quran',
  'Bible',
  'Stephen King',
  'J.K. Rowling',
  'James Clear',
  'Robert Kiyosaki',
  'bestseller',
  'fiction',
  'self help',
  'mystery',
];
