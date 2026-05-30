import { Injectable, Logger } from '@nestjs/common';
import { ShopifyClientService } from '../integrations/shopify/client';
import { VOICE_CATALOG_SEARCH_QUERY } from './shopify-graphql.constants';
import { buildShopifyProductSearchQueries } from './shopify-query-builder.util';
import type { ShopifySearchResult, VoiceCatalogProduct } from './types/voice-product.types';

type GraphqlVariantNode = {
  id: string;
  sku?: string | null;
  barcode?: string | null;
  price?: string | null;
  inventoryQuantity?: number | null;
  availableForSale?: boolean | null;
};

type GraphqlProductNode = {
  id: string;
  title?: string | null;
  featuredImage?: { url?: string | null } | null;
  variants?: { edges?: { node: GraphqlVariantNode }[] | null } | null;
};

function formatUsd(price: string | null | undefined): string | null {
  if (price == null || price === '') return null;
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function mapProductNode(node: GraphqlProductNode): VoiceCatalogProduct | null {
  if (!node?.id) return null;
  const variants =
    node.variants?.edges?.map((e) => e.node).filter((v): v is GraphqlVariantNode => Boolean(v?.id)) ??
    [];
  const variant = variants[0];
  if (!variant) return null;

  const inventory = Number(variant.inventoryQuantity ?? 0);
  const inStock = inventory > 0 || variant.availableForSale !== false;

  return {
    productId: node.id,
    variantId: variant.id,
    title: typeof node.title === 'string' ? node.title : 'Untitled',
    price: formatUsd(variant.price),
    inventory,
    image: node.featuredImage?.url ?? null,
    sku: variant.sku ?? null,
    inStock,
  };
}

@Injectable()
export class ShopifySearchService {
  private readonly logger = new Logger(ShopifySearchService.name);

  constructor(private readonly shopifyClient: ShopifyClientService) {}

  async search(
    tenantId: string,
    agentId: string,
    rawQuery: string,
    limit = 5,
  ): Promise<ShopifySearchResult> {
    const queries = buildShopifyProductSearchQueries(rawQuery);
    if (!queries.length) {
      return { products: [], shopifyLatencyMs: 0, queriesTried: [] };
    }

    const { domain, token, apiVersion } = await this.shopifyClient.getAgentShopifyConfig(
      tenantId,
      agentId,
    );
    const cap = Math.min(Math.max(limit, 1), 12);
    const started = Date.now();

    const batches = await Promise.all(
      queries.map(async (query) => {
        const qStart = Date.now();
        try {
          const data = await this.shopifyClient.adminGraphql<{
            products: { nodes: GraphqlProductNode[] };
          }>(domain, token, VOICE_CATALOG_SEARCH_QUERY, { first: cap, query }, apiVersion);
          const latencyMs = Date.now() - qStart;
          this.logger.log(
            JSON.stringify({
              event: 'shopify.graphql.latency',
              query: query.slice(0, 80),
              latencyMs,
              resultCount: data.products?.nodes?.length ?? 0,
            }),
          );
          return { query, nodes: data.products?.nodes ?? [] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            JSON.stringify({
              event: 'shopify.graphql.error',
              query: query.slice(0, 80),
              message: message.slice(0, 300),
              latencyMs: Date.now() - qStart,
            }),
          );
          return { query, nodes: [] as GraphqlProductNode[] };
        }
      }),
    );

    const shopifyLatencyMs = Date.now() - started;
    const byProductId = new Map<string, VoiceCatalogProduct>();
    for (const { nodes } of batches) {
      for (const node of nodes) {
        const mapped = mapProductNode(node);
        if (mapped && !byProductId.has(mapped.productId)) {
          byProductId.set(mapped.productId, mapped);
        }
      }
    }

    return {
      products: [...byProductId.values()].slice(0, limit),
      shopifyLatencyMs,
      queriesTried: queries,
    };
  }
}
