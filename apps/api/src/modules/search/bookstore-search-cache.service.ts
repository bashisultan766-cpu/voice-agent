import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { isVoiceCommerceFastMode } from '../calls/runtime/voice-commerce-fast-mode.util';
import type { BookstoreVoiceSearchResult } from './types/bookstore-search.types';

const MEMORY_TTL_MS = 5 * 60 * 1000;
const REDIS_TTL_SEC = 15 * 60;
const DEBOUNCE_MS = 400;
const RECENT_SEARCH_MAX = 48;
const CATALOG_SNAPSHOT_TTL_SEC = 30 * 60;

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
    const url = this.config.get<string>('REDIS_URL')?.trim();
    if (!url) return;
    try {
      this.redis = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
      void this.redis.connect().catch((err) => {
        this.logger.warn(`Redis search cache unavailable: ${err instanceof Error ? err.message : err}`);
        this.redis = null;
      });
    } catch (err) {
      this.logger.warn(`Redis search cache init failed: ${err instanceof Error ? err.message : err}`);
      this.redis = null;
    }
  }

  onModuleDestroy(): void {
    void this.redis?.quit();
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
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(this.cacheKey(tenantId, agentId, normalizedQuery));
      if (!raw) return null;
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
    if (!this.redis) return;
    try {
      await this.redis.setex(
        this.cacheKey(tenantId, agentId, normalizedQuery),
        REDIS_TTL_SEC,
        JSON.stringify(payload),
      );
    } catch (err) {
      this.logger.debug(`Redis search cache write skipped: ${err instanceof Error ? err.message : err}`);
    }
  }

  recordRecentSearch(tenantId: string, agentId: string, normalizedQuery: string): void {
    const key = this.recentKey(tenantId, agentId);
    const prev = this.recentSearches.get(key) ?? [];
    const next = [normalizedQuery, ...prev.filter((q) => q !== normalizedQuery)].slice(0, RECENT_SEARCH_MAX);
    this.recentSearches.set(key, next);
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
    if (!this.redis) return;
    try {
      await this.redis.setex(
        this.catalogSnapshotKey(tenantId, agentId, shopDomain),
        CATALOG_SNAPSHOT_TTL_SEC,
        JSON.stringify({ indexSize, builtAt: Date.now() }),
      );
    } catch {
      /* optional */
    }
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
