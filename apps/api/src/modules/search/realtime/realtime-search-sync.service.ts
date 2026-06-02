import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../database/prisma.service';
import { ShopifyProductSyncQueueService } from '../../integrations/shopify/product-sync.queue';
import { BookstoreSearchCacheService, POPULAR_WARM_QUERIES } from '../bookstore-search-cache.service';
import { BookstoreVoiceSearchService } from '../bookstore-voice-search.service';

const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** Periodically warm Redis/PG product index and enqueue Shopify catalog sync. */
@Injectable()
export class RealtimeSearchSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeSearchSyncService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    // Optional: avoids "Cannot read properties of undefined (reading 'get')" if DI order fails in tests.
    @Optional() private readonly config: ConfigService | null,
    private readonly prisma: PrismaService,
    private readonly voiceSearch: BookstoreVoiceSearchService,
    private readonly cache: BookstoreSearchCacheService,
    private readonly syncQueue: ShopifyProductSyncQueueService,
  ) {}

  /** Read interval after module init — ConfigService may not be ready in constructor. */
  private resolveIntervalMs(): number {
    const raw = this.config?.get<string | number>('REALTIME_SEARCH_SYNC_INTERVAL_MS');
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SYNC_INTERVAL_MS;
  }

  onModuleInit(): void {
    const intervalMs = this.resolveIntervalMs();
    void this.runSync('startup').catch((err) => {
      this.logger.warn(`Realtime search sync startup failed: ${(err as Error).message}`);
    });
    this.timer = setInterval(() => {
      void this.runSync('interval').catch((err) => {
        this.logger.warn(`Realtime search sync interval failed: ${(err as Error).message}`);
      });
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runSync(trigger: 'startup' | 'interval' | 'manual' = 'manual'): Promise<void> {
    if (this.running) return;
    this.running = true;
    const started = Date.now();
    try {
      const agents = await this.prisma.productCache.findMany({
        distinct: ['tenantId', 'agentId'],
        select: { tenantId: true, agentId: true, shopDomain: true },
        take: 48,
        orderBy: { updatedAt: 'desc' },
      });

      await Promise.allSettled(
        agents.map(async (row: { tenantId: string; agentId: string; shopDomain: string | null }) => {
          await this.voiceSearch.warmAgentCatalog(row.tenantId, row.agentId, row.shopDomain ?? null);
          const popular = await this.cache.getPopularSearches(row.tenantId, row.agentId, 16);
          const warmQueries = [...new Set([...POPULAR_WARM_QUERIES, ...popular])].slice(0, 24);
          for (const q of warmQueries) {
            this.cache.markWarmQuery(row.tenantId, row.agentId, q);
          }
          try {
            await this.syncQueue.enqueue(row.tenantId, row.agentId);
          } catch {
            /* queue optional when REDIS_URL missing */
          }
        }),
      );

      this.logger.log(
        JSON.stringify({
          event: 'realtime.search.sync_complete',
          trigger,
          agents: agents.length,
          latencyMs: Date.now() - started,
          intervalMs: this.resolveIntervalMs(),
        }),
      );
    } finally {
      this.running = false;
    }
  }
}
