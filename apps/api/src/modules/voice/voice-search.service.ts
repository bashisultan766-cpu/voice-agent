import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ShopifySearchService } from '../shopify/shopify-search.service';
import { VoiceProductCacheService } from '../search/voice-product-cache.service';
import type { SearchProductResponseDto } from './dto/search-product.dto';

@Injectable()
export class VoiceSearchService {
  private readonly logger = new Logger(VoiceSearchService.name);

  constructor(
    private readonly shopifySearch: ShopifySearchService,
    private readonly cache: VoiceProductCacheService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async searchProduct(args: {
    query: string;
    tenantId?: string;
    agentId?: string;
    limit?: number;
  }): Promise<SearchProductResponseDto> {
    const started = Date.now();
    const query = args.query.trim();
    if (!query) {
      throw new BadRequestException('query is required');
    }

    const { tenantId, agentId } = await this.resolveAgentContext(args.tenantId, args.agentId);
    const limit = args.limit ?? 5;

    this.logger.log(
      JSON.stringify({
        event: 'voice.search.started',
        tenantId,
        agentId,
        query: query.slice(0, 80),
        limit,
      }),
    );

    const cacheKey = this.cache.cacheKey(tenantId, agentId, query);
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      const latencyMs = Date.now() - started;
      this.logger.log(
        JSON.stringify({
          event: 'voice.search.success',
          cacheHit: true,
          matchCount: cached.length,
          latencyMs,
          benchmarkMs: latencyMs,
        }),
      );
      return { success: true, products: cached, cacheHit: true, latencyMs };
    }

    try {
      const result = await this.shopifySearch.search(tenantId, agentId, query, limit);
      await this.cache.set(cacheKey, result.products);

      const latencyMs = Date.now() - started;
      this.logger.log(
        JSON.stringify({
          event: 'voice.search.success',
          cacheHit: false,
          matchCount: result.products.length,
          shopifyLatencyMs: result.shopifyLatencyMs,
          latencyMs,
          benchmarkMs: latencyMs,
          queriesTried: result.queriesTried,
        }),
      );

      return {
        success: true,
        products: result.products,
        cacheHit: false,
        latencyMs,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        JSON.stringify({
          event: 'voice.search.failed',
          message: message.slice(0, 400),
          latencyMs: Date.now() - started,
        }),
      );
      return {
        success: false,
        products: [],
        error: message,
        latencyMs: Date.now() - started,
      };
    }
  }

  private async resolveAgentContext(
    tenantId?: string,
    agentId?: string,
  ): Promise<{ tenantId: string; agentId: string }> {
    const envTenant = this.config.get<string>('VOICE_DEFAULT_TENANT_ID')?.trim();
    const envAgent = this.config.get<string>('VOICE_DEFAULT_AGENT_ID')?.trim();

    const resolvedTenant = tenantId?.trim() || envTenant;
    const resolvedAgent = agentId?.trim() || envAgent;

    if (resolvedTenant && resolvedAgent) {
      return { tenantId: resolvedTenant, agentId: resolvedAgent };
    }

    const agent = await this.prisma.agent.findFirst({
      where: { deletedAt: null, status: { in: [AgentStatus.ACTIVE, AgentStatus.READY] } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, tenantId: true },
    });
    if (!agent) {
      throw new BadRequestException(
        'No agent context. Provide tenantId/agentId or set VOICE_DEFAULT_TENANT_ID and VOICE_DEFAULT_AGENT_ID.',
      );
    }
    return { tenantId: resolvedTenant ?? agent.tenantId, agentId: resolvedAgent ?? agent.id };
  }
}
