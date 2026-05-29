import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { isVoiceCommerceFastMode } from '../calls/runtime/voice-commerce-fast-mode.util';
import { BookstoreVoiceSearchService } from './bookstore-voice-search.service';

/** Preload product index + warm query keys on API startup (production voice commerce). */
@Injectable()
export class BookstoreSearchWarmService implements OnModuleInit {
  private readonly logger = new Logger(BookstoreSearchWarmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly voiceSearch: BookstoreVoiceSearchService,
  ) {}

  onModuleInit(): void {
    void this.warmFromProductCache().catch((err) => {
      this.logger.warn(
        `Bookstore warm cache failed: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`,
      );
    });
  }

  private async warmFromProductCache(): Promise<void> {
    const agents = await this.prisma.productCache.findMany({
      distinct: ['tenantId', 'agentId'],
      select: { tenantId: true, agentId: true, shopDomain: true },
      take: 24,
      orderBy: { updatedAt: 'desc' },
    });

    await Promise.allSettled(
      agents.map((row) =>
        this.voiceSearch.warmAgentCatalog(row.tenantId, row.agentId, row.shopDomain ?? null),
      ),
    );

    this.logger.log(
      JSON.stringify({
        event: 'bookstore.search.warm_complete',
        agentsWarmed: agents.length,
        fastMode: isVoiceCommerceFastMode(),
        catalogPreloaded: true,
      }),
    );
  }
}
