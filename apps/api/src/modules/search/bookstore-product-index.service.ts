import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { BookstoreIndexProduct } from './types/bookstore-search.types';
import type { ShopifyProductSummary } from '../agents/shopify-agent.service';
import {
  buildAuthorEmbedding,
  buildCategoryEmbedding,
  buildDescriptionEmbedding,
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
        bodyHtml: true,
        status: true,
      },
      take: 5000,
      orderBy: { updatedAt: 'desc' },
    });

    const products: BookstoreIndexProduct[] = rows.map((row) => {
      const title = row.title ?? '';
      const vendor = row.vendor ?? '';
      const bodyPlain = (row.bodyHtml ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400);
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
        descriptionEmbedding: buildDescriptionEmbedding(row.bodyHtml, row.tags),
        descriptionSnippet: bodyPlain,
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

  /** Hydrate catalog hits from productCache for voice presentation (variants + inventory). */
  async hydrateProducts(
    tenantId: string,
    agentId: string,
    shopDomain: string | null | undefined,
    productIds: string[],
  ): Promise<ShopifyProductSummary[]> {
    const ids = [...new Set(productIds.filter(Boolean))].slice(0, 20);
    if (ids.length === 0) return [];

    const domain = shopDomain?.trim().toLowerCase() || undefined;
    const rows = await this.prisma.productCache.findMany({
      where: {
        tenantId,
        agentId,
        shopifyProductId: { in: ids },
        ...(domain ? { shopDomain: domain } : {}),
      },
      include: { variants: true },
    });

    const order = new Map(ids.map((id, i) => [id, i]));
    const mapped = rows.map((row) => this.toVoiceSummary(row));
    mapped.sort((a, b) => (order.get(a.productId) ?? 999) - (order.get(b.productId) ?? 999));
    return mapped;
  }

  private toVoiceSummary(row: {
    shopifyProductId: string;
    title: string;
    handle: string | null;
    vendor: string | null;
    productType: string | null;
    status: string | null;
    tags: string | null;
    variants: Array<{
      shopifyVariantId: string;
      title: string | null;
      sku: string | null;
      price: unknown;
      inventoryQuantity: number | null;
      availableForSale: boolean | null;
    }>;
  }): ShopifyProductSummary {
    return {
      id: row.shopifyProductId,
      productId: row.shopifyProductId,
      title: row.title,
      handle: row.handle,
      status: row.status ?? 'ACTIVE',
      vendor: row.vendor,
      productType: row.productType,
      tags: row.tags?.split(',').map((t) => t.trim()).filter(Boolean) ?? [],
      isbn: null,
      variants: row.variants.map((v) => ({
        id: v.shopifyVariantId,
        title: v.title ?? 'Default',
        inventory_quantity: v.inventoryQuantity ?? 0,
        sku: v.sku,
        price: v.price != null ? String(v.price) : null,
        availableForSale: v.availableForSale ?? (v.inventoryQuantity ?? 0) > 0,
      })),
      matchReason: 'catalog_recovery',
    };
  }
}
