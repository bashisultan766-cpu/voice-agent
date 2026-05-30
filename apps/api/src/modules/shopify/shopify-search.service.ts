import { Injectable, Logger } from '@nestjs/common';
import { ShopifyClientService } from '../integrations/shopify/client';
import { VOICE_CATALOG_SEARCH_QUERY } from './shopify-graphql.constants';
import { buildShopifyProductSearchQueries, extractIsbnDigits } from './shopify-query-builder.util';
import {
  rankVoiceProducts,
  type RankableVoiceProduct,
} from './voice-product-ranking.util';
import { normalizeVoiceText } from './voice-text-normalize.util';
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

const GRAPHQL_FETCH_CAP = 20;
const MAX_PARALLEL_QUERIES = 4;

function formatUsd(price: string | null | undefined): string | null {
  if (price == null || price === '') return null;
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function mapProductNode(node: GraphqlProductNode): RankableVoiceProduct | null {
  if (!node?.id) return null;
  const variants =
    node.variants?.edges?.map((e) => e.node).filter((v): v is GraphqlVariantNode => Boolean(v?.id)) ??
    [];
  const variant = variants[0];
  if (!variant) return null;

  const inventory = Number(variant.inventoryQuantity ?? 0);
  const inStock = inventory > 0 || variant.availableForSale !== false;
  const skus = variants.map((v) => v.sku).filter((s): s is string => Boolean(s?.trim()));
  const barcodes = variants
    .map((v) => v.barcode)
    .filter((b): b is string => Boolean(b?.trim()));

  return {
    productId: node.id,
    variantId: variant.id,
    title: typeof node.title === 'string' ? node.title : 'Untitled',
    price: formatUsd(variant.price),
    inventory,
    image: node.featuredImage?.url ?? null,
    sku: variant.sku ?? null,
    inStock,
    skus,
    barcodes,
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
    const normalizedQuery = normalizeVoiceText(rawQuery);
    const queries = buildShopifyProductSearchQueries(rawQuery, MAX_PARALLEL_QUERIES);
    if (!queries.length) {
      return {
        products: [],
        shopifyLatencyMs: 0,
        queriesTried: [],
        normalizedQuery,
      };
    }

    const { domain, token, apiVersion } = await this.shopifyClient.getAgentShopifyConfig(
      tenantId,
      agentId,
    );
    const fetchCap = Math.max(GRAPHQL_FETCH_CAP, Math.min(limit * 4, 24));
    const started = Date.now();
    const isbn = extractIsbnDigits(rawQuery);

    const batches = await Promise.all(
      queries.map(async (query) => {
        const qStart = Date.now();
        try {
          const data = await this.shopifyClient.adminGraphql<{
            products: { nodes: GraphqlProductNode[] };
          }>(domain, token, VOICE_CATALOG_SEARCH_QUERY, { first: fetchCap, query }, apiVersion);
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
    const byProductId = new Map<string, RankableVoiceProduct>();
    for (const { nodes } of batches) {
      for (const node of nodes) {
        const mapped = mapProductNode(node);
        if (mapped && !byProductId.has(mapped.productId)) {
          byProductId.set(mapped.productId, mapped);
        }
      }
    }

    const { products: ranked, diagnostics } = rankVoiceProducts(
      rawQuery,
      [...byProductId.values()],
      isbn,
      limit,
    );

    const products: VoiceCatalogProduct[] = ranked.map((p) => ({
      productId: p.productId,
      variantId: p.variantId,
      title: p.title,
      price: p.price,
      inventory: p.inventory,
      image: p.image,
      sku: p.sku,
      inStock: p.inStock,
      score: p.score,
      scoreBreakdown: p.scoreBreakdown,
      matchedTokens: p.matchedTokens,
      normalizedTitle: p.normalizedTitle,
    }));

    return {
      products,
      shopifyLatencyMs,
      queriesTried: queries,
      normalizedQuery,
      ranking: diagnostics,
    };
  }
}
