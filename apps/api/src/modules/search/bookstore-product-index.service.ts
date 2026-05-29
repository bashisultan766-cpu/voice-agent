import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { BookstoreIndexProduct } from './types/bookstore-search.types';
import {
  buildAuthorEmbedding,
  buildCategoryEmbedding,
  buildTitleEmbedding,
} from './ranking/bookstore-semantic.util';
import { deriveSeriesKey, extractVolumeNumber } from './ranking/bookstore-series.util';
import { normalizeBookTitleForSearch } from './ranking/bookstore-title-normalizer.util';

@Injectable()
export class BookstoreProductIndexService {
  private readonly logger = new Logger(BookstoreProductIndexService.name);
  private readonly indexes = new Map<string, { builtAt: number; products: BookstoreIndexProduct[] }>();
  private static readonly INDEX_TTL_MS = 10 * 60 * 1000;

  constructor(private readonly prisma: PrismaService) {}

  private indexKey(tenantId: string, agentId: string, shopDomain?: string | null): string {
    return `${tenantId}:${agentId}:${shopDomain ?? '*'}`;
  }

  async getIndex(
    tenantId: string,
    agentId: string,
    shopDomain?: string | null,
  ): Promise<{ products: BookstoreIndexProduct[]; embeddings: Map<string, Float32Array> }> {
    const key = this.indexKey(tenantId, agentId, shopDomain);
    const cached = this.indexes.get(key);
    if (cached && Date.now() - cached.builtAt < BookstoreProductIndexService.INDEX_TTL_MS) {
      const embeddings = new Map<string, Float32Array>();
      for (const p of cached.products) embeddings.set(p.productId, p.embedding);
      return { products: cached.products, embeddings };
    }

    const domain = shopDomain?.trim().toLowerCase() || undefined;
    const rows = await this.prisma.productCache.findMany({
      where: {
        tenantId,
        agentId,
        ...(domain ? { shopDomain: domain } : {}),
      },
      select: {
        shopifyProductId: true,
        title: true,
        handle: true,
        vendor: true,
        productType: true,
        tags: true,
      },
      take: 5000,
      orderBy: { updatedAt: 'desc' },
    });

    const products: BookstoreIndexProduct[] = rows.map((row) => {
      const title = row.title ?? '';
      const vendor = row.vendor ?? '';
      return {
        productId: row.shopifyProductId,
        title,
        handle: row.handle,
        vendor: row.vendor,
        productType: row.productType,
        tags: row.tags,
        normalizedTitle: normalizeBookTitleForSearch(title),
        normalizedAuthor: normalizeBookTitleForSearch(vendor),
        seriesKey: deriveSeriesKey(title),
        volumeNumber: extractVolumeNumber(title),
        embedding: buildTitleEmbedding(title),
        authorEmbedding: buildAuthorEmbedding(vendor),
        categoryEmbedding: buildCategoryEmbedding(row.productType, row.tags),
      };
    });

    this.indexes.set(key, { builtAt: Date.now(), products });
    this.logger.log(
      JSON.stringify({
        event: 'bookstore.search.index_built',
        tenantId,
        agentId,
        indexSize: products.length,
      }),
    );

    const embeddings = new Map<string, Float32Array>();
    for (const p of products) embeddings.set(p.productId, p.embedding);
    return { products, embeddings };
  }

  /** Fast local candidate IDs from normalized index (token overlap). */
  localCandidateIds(
    index: BookstoreIndexProduct[],
    query: string,
    limit = 40,
  ): string[] {
    const tokens = normalizeBookTitleForSearch(query).split(/\s+/).filter((t) => t.length > 1);
    if (tokens.length === 0) return [];

    const scored = index
      .map((p) => {
        let hits = 0;
        for (const t of tokens) {
          if (p.normalizedTitle.includes(t) || p.normalizedAuthor.includes(t)) hits++;
        }
        return { id: p.productId, hits };
      })
      .filter((s) => s.hits > 0)
      .sort((a, b) => b.hits - a.hits);

    return scored.slice(0, limit).map((s) => s.id);
  }
}
