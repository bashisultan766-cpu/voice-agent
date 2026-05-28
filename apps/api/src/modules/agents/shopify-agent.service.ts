import { Injectable, Logger } from '@nestjs/common';
import { AgentsService } from './agents.service';
import { toProductGid, toProductVariantGid } from '../integrations/shopify/shopify-ids';
import {
  normalizeForMatch,
  PRODUCT_SEARCH_CONFIDENT_MIN_SCORE,
  PRODUCT_SEARCH_CONFIRM_MIN_SCORE,
  rankCatalogProductsForVoice,
} from './shopify-product-relevance.util';
import {
  buildShopifyProductSearchAttempts,
  cleanVoiceProductQuery,
  extractBookTitlesFromUtterance,
  type ShopifySearchAttempt,
} from './voice-product-query.util';
import {
  detectBookCategoryQuery,
  formatCategorySearchVoiceSummary,
  type VoiceProductOfferInput,
} from '../calls/runtime/book-sales-voice.util';
import {
  buildProductSearchVoiceSummary,
  pickInStockSearchPresentation,
} from '../calls/runtime/voice-stock-sales-policy.util';

const SHOPIFY_API_VERSION = '2024-01';
const SHOPIFY_GRAPHQL_VERSION = '2024-10';

const VOICE_PRODUCT_SEARCH_QUERY = `
  query VoiceProductSearch($first: Int!, $query: String!) {
    products(first: $first, query: $query) {
      nodes {
        id
        title
        handle
        status
        tags
        vendor
        productType
        metafields(first: 30) {
          nodes {
            namespace
            key
            value
          }
        }
        variants(first: 25) {
          edges {
            node {
              id
              title
              sku
              barcode
              price
              compareAtPrice
              inventoryQuantity
              availableForSale
              metafields(first: 15) {
                nodes {
                  namespace
                  key
                  value
                }
              }
            }
          }
        }
      }
    }
  }
`;

const VOICE_PRODUCT_BY_ID_QUERY = `
  query VoiceProductById($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      status
      tags
      vendor
      productType
      metafields(first: 30) {
        nodes {
          namespace
          key
          value
        }
      }
      variants(first: 25) {
        edges {
          node {
            id
            title
            sku
            barcode
            price
            compareAtPrice
            inventoryQuantity
            availableForSale
            metafields(first: 15) {
              nodes {
                namespace
                key
                value
              }
            }
          }
        }
      }
    }
  }
`;

const VOICE_PRODUCT_VIA_VARIANT_QUERY = `
  query VoiceProductViaVariant($id: ID!) {
    productVariant(id: $id) {
      id
      product {
        id
        title
        handle
        status
        tags
        vendor
        productType
        metafields(first: 30) {
          nodes {
            namespace
            key
            value
          }
        }
        variants(first: 25) {
          edges {
            node {
              id
              title
              sku
              barcode
              price
              compareAtPrice
              inventoryQuantity
              availableForSale
              metafields(first: 15) {
                nodes {
                  namespace
                  key
                  value
                }
              }
            }
          }
        }
      }
    }
  }
`;

const ISBN_KEY_RE = /^isbn(?:[-_]?1[03])?$/i;

function formatVoiceUsd(price: string | null | undefined): string | null {
  if (price == null || price === '') return null;
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export interface ShopifyOrderSummary {
  id: string;
  name: string;
  financial_status: string;
  fulfillment_status: string | null;
  created_at: string;
  total_price: string;
  note?: string;
}

/** Live catalog row: compatible with legacy `search_books` / inventory helpers. */
export interface ShopifyProductSummary {
  id: string;
  productId: string;
  title: string;
  handle?: string | null;
  status: string;
  vendor?: string | null;
  productType?: string | null;
  tags?: string[];
  isbn?: string | null;
  variants: Array<{
    id: string;
    title: string;
    inventory_quantity: number;
    sku?: string | null;
    barcode?: string | null;
    price?: string | null;
    isbn?: string | null;
    availableForSale?: boolean;
  }>;
  /** Set after local relevance ranking (voice search). */
  relevanceScore?: number;
  matchReason?: string;
}

/** Structured log fields for `shopify.voice.product_search_live`. */
export interface ShopifyProductSearchVoiceLog {
  productSearchInputRaw: string;
  cleanedQuery: string;
  probableTitle: string;
  shopifyQueriesTried: Array<{ label: string; query: string }>;
  /** Unique products returned from Shopify after merging all search attempts. */
  productsReturned: number;
  productsReturnedCount: number;
  /** Count of merged products with relevance score ≥ 600 (not weak). */
  productsAfterRanking: number;
  rankedProducts: Array<{ title: string; score: number; matchReason: string }>;
  /** Best-scoring candidate title before customer-facing gating. */
  topProduct: string | null;
  topProductTitle: string | null;
  topScore: number | null;
  topMatchReason: string | null;
  lowConfidenceSearch: boolean;
  finalVoiceSummary: string;
  /** @deprecated */ queryOriginal?: string;
  /** @deprecated */ normalizedQuery?: string;
  /** @deprecated */ productsReturnedByShopify?: number;
  /** @deprecated */ topRelevanceScore?: number | null;
  /** @deprecated */ matchReason?: string | null;
}

type GraphqlVariantNode = {
  id: string;
  title?: string;
  sku?: string | null;
  barcode?: string | null;
  inventoryQuantity?: number | null;
  availableForSale?: boolean | null;
  /** Admin API: Money scalar — do not select subfields in GraphQL. */
  price?: string | number | null;
  compareAtPrice?: string | number | null;
  metafields?: { nodes?: Array<{ namespace?: string; key?: string; value?: string }> };
};

type GraphqlProductNode = {
  id: string;
  title?: string;
  handle?: string;
  status?: string;
  tags?: string[];
  vendor?: string;
  productType?: string;
  metafields?: { nodes?: Array<{ namespace?: string; key?: string; value?: string }> };
  variants?: {
    edges?: Array<{ node?: GraphqlVariantNode | null } | null>;
  };
};

@Injectable()
export class ShopifyAgentService {
  private static shopifyScalarPriceQueryLogged = false;

  private readonly logger = new Logger(ShopifyAgentService.name);

  constructor(private readonly agentsService: AgentsService) {}

  private normalizeAdminDomain(storeUrl: string): string {
    return storeUrl
      .replace(/^https?:\/\//i, '')
      .replace(/\/$/, '')
      .split('/')[0]
      .toLowerCase();
  }

  private async adminGraphql<T>(
    storeUrl: string,
    token: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const domain = this.normalizeAdminDomain(storeUrl);
    const res = await fetch(`https://${domain}/admin/api/${SHOPIFY_GRAPHQL_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json().catch(() => null)) as {
      data?: T;
      errors?: Array<{ message?: string }>;
    } | null;
    if (!res.ok) {
      const msg = json?.errors?.[0]?.message ?? (await res.text()).slice(0, 200);
      throw new Error(`Shopify GraphQL HTTP ${res.status}: ${msg}`);
    }
    if (json?.errors?.length) {
      throw new Error(json.errors.map((e) => e.message ?? 'GraphQL error').join('; '));
    }
    if (json?.data === undefined || json.data === null) {
      throw new Error('Shopify GraphQL returned empty data.');
    }
    if (!ShopifyAgentService.shopifyScalarPriceQueryLogged) {
      console.log('SHOPIFY QUERY FIXED - scalar fields used correctly');
      ShopifyAgentService.shopifyScalarPriceQueryLogged = true;
    }
    return json.data;
  }

  private metafieldList(
    raw: { nodes?: Array<{ namespace?: string; key?: string; value?: string }> } | undefined,
  ): Array<{ key: string; value: string }> {
    return (raw?.nodes ?? [])
      .map((n) => ({
        key: typeof n.key === 'string' ? n.key.trim() : '',
        value: typeof n.value === 'string' ? n.value.trim() : '',
      }))
      .filter((n) => n.key && n.value);
  }

  private normalizeIsbnCandidate(value: string): string | null {
    const cleaned = value.replace(/[^0-9Xx]/g, '');
    if (cleaned.length === 10 || cleaned.length === 13) return cleaned.toUpperCase();
    return null;
  }

  private pickIsbn(
    sku: string | null | undefined,
    barcode: string | null | undefined,
    mf: Array<{ key: string; value: string }>,
  ): string | null {
    const fromSku = this.normalizeIsbnCandidate(sku ?? '');
    if (fromSku) return fromSku;
    const fromBc = this.normalizeIsbnCandidate(barcode ?? '');
    if (fromBc) return fromBc;
    for (const m of mf) {
      if (!ISBN_KEY_RE.test(m.key)) continue;
      const v = this.normalizeIsbnCandidate(m.value);
      if (v) return v;
    }
    return null;
  }

  private isbnFromTags(tags: string[]): string | null {
    for (const t of tags) {
      const v = this.normalizeIsbnCandidate(t);
      if (v) return v;
    }
    return null;
  }

  private variantNodesFromProduct(node: GraphqlProductNode): GraphqlVariantNode[] {
    const edges = node.variants?.edges ?? [];
    return edges.map((e) => e?.node).filter((v): v is GraphqlVariantNode => v != null && Boolean(v.id));
  }

  private moneyScalarToString(value: string | number | null | undefined): string | null {
    if (value === null || value === undefined || value === '') return null;
    return String(value);
  }

  private mapGraphqlProductNode(node: GraphqlProductNode | null | undefined): ShopifyProductSummary | null {
    if (!node?.id) return null;
    const productMf = this.metafieldList(node.metafields);
    const tags = Array.isArray(node.tags) ? node.tags.map((t) => String(t)) : [];
    const variantNodes = this.variantNodesFromProduct(node);
    const variants = variantNodes.map((v) => {
      const vmf = this.metafieldList(v.metafields);
      const isbn = this.pickIsbn(v.sku ?? null, v.barcode ?? null, vmf);
      return {
        id: String(v.id),
        title: typeof v.title === 'string' ? v.title : '',
        inventory_quantity: Number(v.inventoryQuantity ?? 0),
        sku: v.sku ?? null,
        barcode: v.barcode ?? null,
        price: this.moneyScalarToString(v.price),
        isbn,
        availableForSale: v.availableForSale !== false,
      };
    });
    const fallbackIsbn = this.pickIsbn(null, null, productMf);
    const anyVariantIsbn = variants.map((x) => x.isbn).find(Boolean) ?? null;
    const tagIsbn = this.isbnFromTags(tags);
    return {
      id: node.id,
      productId: node.id,
      title: typeof node.title === 'string' ? node.title : 'Untitled',
      handle: node.handle ?? null,
      status: typeof node.status === 'string' ? node.status : 'ACTIVE',
      vendor: node.vendor ?? null,
      productType: node.productType ?? null,
      tags,
      isbn: anyVariantIsbn ?? fallbackIsbn ?? tagIsbn ?? null,
      variants,
    };
  }

  private async fetchProductsMergedSearch(
    storeUrl: string,
    token: string,
    attempts: ShopifySearchAttempt[],
    limitPerQuery: number,
  ): Promise<{ products: ShopifyProductSummary[]; shopifyQueriesTried: ShopifySearchAttempt[] }> {
    const cap = Math.min(Math.max(limitPerQuery, 1), 25);
    const byId = new Map<string, ShopifyProductSummary>();
    const tried: ShopifySearchAttempt[] = [];

    for (const attempt of attempts) {
      if (!attempt.query.trim()) continue;
      tried.push(attempt);
      const data = await this.adminGraphql<{ products: { nodes: GraphqlProductNode[] } }>(
        storeUrl,
        token,
        VOICE_PRODUCT_SEARCH_QUERY,
        { first: cap, query: attempt.query },
      );
      const nodes = data.products?.nodes ?? [];
      for (const n of nodes) {
        const p = this.mapGraphqlProductNode(n);
        if (p && !byId.has(p.productId)) byId.set(p.productId, p);
      }
    }

    return { products: [...byId.values()], shopifyQueriesTried: tried };
  }

  private async fetchShopify<T>(
    storeUrl: string,
    token: string,
    path: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const base = storeUrl.replace(/\/$/, '');
    const pathWithQuery = params ? `${path}?${new URLSearchParams(params).toString()}` : path;
    const url = path.startsWith('http') ? pathWithQuery : `${base}${path.startsWith('/') ? '' : '/'}${pathWithQuery}`;
    const res = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  /**
   * Get order status for voice agent. Look up by order number (e.g. 1010) or phone.
   */
  async getOrderStatus(
    tenantId: string,
    agentId: string,
    orderNumberOrPhone: string,
  ): Promise<{ ok: boolean; orders?: ShopifyOrderSummary[]; voiceSummary?: string; error?: string }> {
    const config = await this.agentsService.getShopifyConfig(tenantId, agentId);
    if (!config) {
      return { ok: false, error: 'Shopify not connected for this agent.' };
    }
    const trimmed = orderNumberOrPhone.trim().replace(/\D/g, '');
    const isLikelyPhone = trimmed.length >= 10;
    try {
      if (isLikelyPhone) {
        const data = await this.fetchShopify<{
          orders?: {
            id: number;
            name: string;
            financial_status: string;
            fulfillment_status: string | null;
            created_at: string;
            total_price: string;
            note?: string;
            billing_address?: { phone?: string };
          }[];
        }>(config.shopifyStoreUrl, config.shopifyAdminToken, `/admin/api/${SHOPIFY_API_VERSION}/orders.json`, {
          status: 'any',
          limit: '50',
        });
        const orders = (data.orders ?? []).filter(
          (o) => o.billing_address?.phone && o.billing_address.phone.replace(/\D/g, '').endsWith(trimmed.slice(-10)),
        );
        const list = orders.slice(0, 5).map((o) => ({
          id: String(o.id),
          name: o.name,
          financial_status: o.financial_status,
          fulfillment_status: o.fulfillment_status,
          created_at: o.created_at,
          total_price: o.total_price,
          note: o.note,
        }));
        const voiceSummary =
          list.length === 0
            ? `No orders found for that phone number.`
            : list.length === 1
              ? `Order ${list[0].name}: ${list[0].financial_status}, fulfillment ${list[0].fulfillment_status ?? 'pending'}. Total ${list[0].total_price}.`
              : `Found ${list.length} orders. Latest: ${list[0].name}, ${list[0].financial_status}, ${list[0].fulfillment_status ?? 'pending'}.`;
        return { ok: true, orders: list, voiceSummary };
      } else {
        const data = await this.fetchShopify<{
          orders?: {
            id: number;
            name: string;
            financial_status: string;
            fulfillment_status: string | null;
            created_at: string;
            total_price: string;
            note?: string;
          }[];
        }>(config.shopifyStoreUrl, config.shopifyAdminToken, `/admin/api/${SHOPIFY_API_VERSION}/orders.json`, {
          name: orderNumberOrPhone.trim(),
          status: 'any',
          limit: '5',
        });
        const orders = data.orders ?? [];
        const list = orders.map((o) => ({
          id: String(o.id),
          name: o.name,
          financial_status: o.financial_status,
          fulfillment_status: o.fulfillment_status,
          created_at: o.created_at,
          total_price: o.total_price,
          note: o.note,
        }));
        const voiceSummary =
          list.length === 0
            ? `No order found with number ${orderNumberOrPhone}.`
            : `Order ${list[0].name}: ${list[0].financial_status}, fulfillment ${list[0].fulfillment_status ?? 'pending'}. Total ${list[0].total_price}.`;
        return { ok: true, orders: list, voiceSummary };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Shopify request failed';
      return { ok: false, error: message };
    }
  }

  /**
   * Search products via Shopify Admin GraphQL (live catalog — no local cache required).
   * Matches title, description, SKU, tags, and common ISBN metafields / SKU patterns.
   */
  async searchProducts(
    tenantId: string,
    agentId: string,
    query: string,
    limit = 5,
  ): Promise<{
    ok: boolean;
    products?: ShopifyProductSummary[];
    voiceSummary?: string;
    error?: string;
    searchVoiceLog?: ShopifyProductSearchVoiceLog;
  }> {
    const config = await this.agentsService.getShopifyConfig(tenantId, agentId);
    if (!config) {
      return { ok: false, error: 'Shopify not connected for this agent.' };
    }
    const productSearchInputRaw = query.trim();
    if (!productSearchInputRaw) {
      const searchVoiceLog: ShopifyProductSearchVoiceLog = {
        productSearchInputRaw: '',
        cleanedQuery: '',
        probableTitle: '',
        shopifyQueriesTried: [],
        productsReturned: 0,
        productsReturnedCount: 0,
        productsAfterRanking: 0,
        rankedProducts: [],
        topProduct: null,
        topProductTitle: null,
        topScore: null,
        topMatchReason: 'empty_query',
        lowConfidenceSearch: true,
        finalVoiceSummary: `I didn't catch what to search. Could you say the product name again, or spell it?`,
      };
      this.logger.log(
        JSON.stringify({
          event: 'shopify.voice.product_search_live',
          tenantId,
          agentId,
          productsFound: 0,
          ...searchVoiceLog,
          productSearchInputRaw: searchVoiceLog.productSearchInputRaw,
          probableTitle: searchVoiceLog.probableTitle,
        }),
      );
      return {
        ok: true,
        products: [],
        voiceSummary: searchVoiceLog.finalVoiceSummary,
        searchVoiceLog,
      };
    }

    const titlePhrases = extractBookTitlesFromUtterance(productSearchInputRaw);
    if (titlePhrases.length > 1) {
      const merged: ShopifyProductSummary[] = [];
      const seenIds = new Set<string>();
      const summaries: string[] = [];
      for (const phrase of titlePhrases.slice(0, 4)) {
        const one = await this.searchProducts(tenantId, agentId, phrase, Math.max(2, Math.ceil(limit / titlePhrases.length)));
        if (!one.ok) {
          return one;
        }
        for (const p of one.products ?? []) {
          if (!seenIds.has(p.productId)) {
            seenIds.add(p.productId);
            merged.push(p);
          }
        }
        if (one.voiceSummary?.trim()) summaries.push(one.voiceSummary.trim());
      }
      return {
        ok: true,
        products: merged.slice(0, limit),
        voiceSummary:
          summaries.length > 0
            ? summaries.join(' ')
            : merged.length > 0
              ? `I found ${merged.length} titles from your list. Which one would you like?`
              : `I couldn't find an exact match for those titles. Could you repeat the title or author?`,
        searchVoiceLog: {
          productSearchInputRaw,
          cleanedQuery: titlePhrases.join(' | '),
          probableTitle: titlePhrases[0] ?? '',
          shopifyQueriesTried: titlePhrases.map((t) => ({ label: 'multi_title', query: t })),
          productsReturned: merged.length,
          productsReturnedCount: merged.length,
          productsAfterRanking: merged.length,
          rankedProducts: [],
          topProduct: merged[0]?.title ?? null,
          topProductTitle: merged[0]?.title ?? null,
          topScore: merged[0]?.relevanceScore ?? null,
          topMatchReason: 'multi_title_merge',
          lowConfidenceSearch: merged.length === 0,
          finalVoiceSummary: summaries[0] ?? '',
        },
      };
    }

    const { cleanedQuery, probableTitle } = cleanVoiceProductQuery(productSearchInputRaw);
    const attempts = buildShopifyProductSearchAttempts({
      probableTitle,
      cleanedQuery,
      productSearchInputRaw,
    });
    if (attempts.length === 0) {
      return { ok: true, products: [], voiceSummary: 'No products found in Shopify store.' };
    }
    try {
      const internalFetchCap = 25;
      const { products: rawProducts, shopifyQueriesTried } = await this.fetchProductsMergedSearch(
        config.shopifyStoreUrl,
        config.shopifyAdminToken,
        attempts,
        internalFetchCap,
      );
      const normalizedQuery = normalizeForMatch(probableTitle || cleanedQuery || productSearchInputRaw);
      const maxVoiceHits = Math.min(3, Math.max(1, limit));
      const {
        ranked,
        rankedForLog,
        bestScore,
        bestReason,
        lowConfidence,
        productsAfterRanking,
        topProduct,
      } = rankCatalogProductsForVoice(
        productSearchInputRaw,
        probableTitle || cleanedQuery || productSearchInputRaw,
        rawProducts,
        maxVoiceHits,
      );

      const topRankedScore = ranked[0]?.relevanceScore ?? 0;
      const displayTitle = probableTitle || cleanedQuery || productSearchInputRaw || 'that title';

      let products: ShopifyProductSummary[] = ranked.map((p) => ({
        ...p,
        relevanceScore: p.relevanceScore,
        matchReason: p.matchReason,
      }));

      const toOffer = (p: ShopifyProductSummary): VoiceProductOfferInput => ({
        title: p.title,
        variants: p.variants.map((v) => ({
          price: v.price,
          inventory_quantity: v.inventory_quantity,
          availableForSale: v.availableForSale,
        })),
      });

      const categoryLabel = detectBookCategoryQuery(productSearchInputRaw);
      let finalVoiceSummary: string;
      if (bestScore < PRODUCT_SEARCH_CONFIRM_MIN_SCORE || products.length === 0) {
        products = [];
        finalVoiceSummary = `I couldn't find an exact match, but I can check similar titles. Could you repeat the title or author?`;
      } else if (categoryLabel && products.length > 1) {
        finalVoiceSummary = formatCategorySearchVoiceSummary(
          categoryLabel,
          products.map(toOffer),
        );
      } else {
        const stockPick = pickInStockSearchPresentation(products, toOffer);
        const requiresClarification = topRankedScore < PRODUCT_SEARCH_CONFIDENT_MIN_SCORE;
        finalVoiceSummary = buildProductSearchVoiceSummary({
          primary: toOffer(stockPick.primary),
          topWasOutOfStock: stockPick.topWasOutOfStock,
          unavailableTitle: stockPick.unavailableTitle,
          requiresClarification: requiresClarification && !stockPick.topWasOutOfStock,
        });
        if (products.length > 1 && !categoryLabel && !stockPick.topWasOutOfStock) {
          finalVoiceSummary = `${finalVoiceSummary} I also have other matches if you want to hear them.`;
        }
        if (stockPick.primary.productId !== products[0]?.productId) {
          products = [
            stockPick.primary,
            ...products.filter((p) => p.productId !== stockPick.primary.productId),
          ].slice(0, products.length);
        }
      }

      const searchVoiceLog: ShopifyProductSearchVoiceLog = {
        productSearchInputRaw,
        cleanedQuery,
        probableTitle,
        shopifyQueriesTried: shopifyQueriesTried.map((a) => ({ label: a.label, query: a.query })),
        productsReturned: rawProducts.length,
        productsReturnedCount: rawProducts.length,
        productsAfterRanking,
        rankedProducts: rankedForLog,
        topProduct,
        topProductTitle: topProduct,
        topScore: bestScore,
        topMatchReason: bestReason,
        lowConfidenceSearch: lowConfidence || bestScore < PRODUCT_SEARCH_CONFIRM_MIN_SCORE,
        finalVoiceSummary,
        queryOriginal: productSearchInputRaw,
        normalizedQuery,
        productsReturnedByShopify: rawProducts.length,
        topRelevanceScore: bestScore,
        matchReason: bestReason,
      };

      this.logger.log(
        JSON.stringify({
          event: 'shopify.voice.product_search_live',
          tenantId,
          agentId,
          productsFound: products.length,
          ...searchVoiceLog,
        }),
      );

      return { ok: true, products, voiceSummary: finalVoiceSummary, searchVoiceLog };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Shopify request failed';
      this.logger.warn(
        JSON.stringify({
          event: 'shopify.voice.product_search_failed',
          tenantId,
          agentId,
          query,
          message: message.slice(0, 300),
        }),
      );
      return { ok: false, error: message };
    }
  }

  /**
   * Load one product from Shopify when the local product cache is empty or stale.
   */
  async getProductLive(
    tenantId: string,
    agentId: string,
    lookup: { productId?: string; variantId?: string; title?: string },
  ): Promise<ShopifyProductSummary | null> {
    const config = await this.agentsService.getShopifyConfig(tenantId, agentId);
    if (!config) return null;
    const { shopifyStoreUrl: storeUrl, shopifyAdminToken: token } = config;
    try {
      if (lookup.productId?.trim()) {
        const gid = toProductGid(lookup.productId.trim());
        const data = await this.adminGraphql<{ product: GraphqlProductNode | null }>(storeUrl, token, VOICE_PRODUCT_BY_ID_QUERY, {
          id: gid,
        });
        return this.mapGraphqlProductNode(data.product);
      }
      if (lookup.variantId?.trim()) {
        const gid = toProductVariantGid(lookup.variantId.trim());
        const data = await this.adminGraphql<{
          productVariant: { product: GraphqlProductNode | null } | null;
        }>(storeUrl, token, VOICE_PRODUCT_VIA_VARIANT_QUERY, { id: gid });
        return this.mapGraphqlProductNode(data.productVariant?.product);
      }
      if (lookup.title?.trim()) {
        const { products } = await this.fetchProductsMergedSearch(storeUrl, token, [{ label: 'title_lookup', query: lookup.title.trim() }], 1);
        return products[0] ?? null;
      }
      return null;
    } catch (err) {
      this.logger.warn(
        JSON.stringify({
          event: 'shopify.voice.product_live_fetch_failed',
          tenantId,
          agentId,
          lookup,
          message: err instanceof Error ? err.message.slice(0, 240) : 'error',
        }),
      );
      return null;
    }
  }

  /**
   * Diagnostic: replay product search with full query strategy + ranking (for support / staging).
   */
  async debugProductSearch(
    tenantId: string,
    agentId: string,
    query: string,
  ): Promise<{
    cleanedQuery: string;
    probableTitle: string;
    shopifyQueriesTried: Array<{ label: string; query: string }>;
    productsReturned: number;
    productsAfterRanking: number;
    topProduct: string | null;
    rawShopifyProductTitles: string[];
    rankedProducts: Array<{ title: string; score: number; matchReason: string }>;
    topScore: number | null;
    topMatchReason: string | null;
    selectedProduct: ShopifyProductSummary | null;
    selectionExplanation: string;
  }> {
    const config = await this.agentsService.getShopifyConfig(tenantId, agentId);
    if (!config) {
      return {
        cleanedQuery: '',
        probableTitle: '',
        shopifyQueriesTried: [],
        productsReturned: 0,
        productsAfterRanking: 0,
        topProduct: null,
        rawShopifyProductTitles: [],
        rankedProducts: [],
        topScore: null,
        topMatchReason: null,
        selectedProduct: null,
        selectionExplanation: 'Shopify not connected for this agent.',
      };
    }

    const rawQ = query.trim();
    const { cleanedQuery, probableTitle } = cleanVoiceProductQuery(rawQ);
    const attempts = buildShopifyProductSearchAttempts({
      probableTitle,
      cleanedQuery,
      productSearchInputRaw: rawQ,
    });

    const { products: rawProducts, shopifyQueriesTried } = await this.fetchProductsMergedSearch(
      config.shopifyStoreUrl,
      config.shopifyAdminToken,
      attempts,
      25,
    );

    const rankAgainst = probableTitle || cleanedQuery || rawQ;
    const { ranked, rankedForLog, bestScore, bestReason, productsAfterRanking, topProduct } = rankCatalogProductsForVoice(
      rawQ,
      rankAgainst,
      rawProducts,
      3,
    );

    const topRankedScore = ranked[0]?.relevanceScore ?? 0;
    let selected: ShopifyProductSummary | null = ranked[0] ?? null;
    let explanation: string;

    if (!rawProducts.length) {
      explanation = 'No products returned from Shopify for any attempted query.';
      selected = null;
    } else if (bestScore < PRODUCT_SEARCH_CONFIRM_MIN_SCORE) {
      explanation = `Top relevance score ${bestScore} is below confirm threshold ${PRODUCT_SEARCH_CONFIRM_MIN_SCORE}; the agent will not present a product as a verified match.`;
      selected = null;
    } else if (topRankedScore < PRODUCT_SEARCH_CONFIDENT_MIN_SCORE) {
      explanation = `Score ${topRankedScore} is in the confirmation band (${PRODUCT_SEARCH_CONFIRM_MIN_SCORE}–${PRODUCT_SEARCH_CONFIDENT_MIN_SCORE - 1}); the agent should ask the customer to confirm before quoting price or stock.`;
    } else if (ranked.length > 1) {
      explanation = `Score ${topRankedScore} is confident, but multiple products met the confirm threshold; the agent should ask which item the customer wants.`;
    } else {
      explanation = `Score ${topRankedScore} meets the confident threshold (${PRODUCT_SEARCH_CONFIDENT_MIN_SCORE}+); the agent may answer with price and stock.`;
    }

    return {
      cleanedQuery,
      probableTitle,
      shopifyQueriesTried: shopifyQueriesTried.map((a) => ({ label: a.label, query: a.query })),
      productsReturned: rawProducts.length,
      productsAfterRanking,
      topProduct,
      rawShopifyProductTitles: rawProducts.map((p) => p.title),
      rankedProducts: rankedForLog,
      topScore: bestScore,
      topMatchReason: bestReason,
      selectedProduct: selected,
      selectionExplanation: explanation,
    };
  }
}
