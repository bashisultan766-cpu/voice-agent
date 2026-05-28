import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { ShopifyClientService } from './client';
import { Prisma } from '@prisma/client';
import { ShopifyGraphqlError } from './shopify-errors';
import { productIdLookupKeys, toProductGid, toProductVariantGid, variantIdLookupKeys } from './shopify-ids';

const PRODUCTS_PAGE_SIZE = Math.min(Math.max(Number(process.env.SHOPIFY_SYNC_PRODUCTS_PAGE) || 50, 1), 100);
const VARIANTS_PAGE_SIZE = Math.min(Math.max(Number(process.env.SHOPIFY_SYNC_VARIANTS_PAGE) || 100, 1), 250);
const SYNC_THROTTLE_MS = Math.max(Number(process.env.SHOPIFY_SYNC_THROTTLE_MS) || 0, 0);
const MAX_PRODUCT_SYNC_PAGES = Math.max(Number(process.env.SHOPIFY_SYNC_MAX_PRODUCT_PAGES) || 500, 1);
const MAX_VARIANT_SYNC_PAGES = Math.max(Number(process.env.SHOPIFY_SYNC_MAX_VARIANT_PAGES) || 500, 1);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type RepairedVariantCacheRow = Prisma.VariantCacheGetPayload<{
  include: { product: { select: { title: true; shopifyProductId: true } } };
}>;

const REPAIR_VARIANT_BY_ID_QUERY = `
  query RepairVariantById($id: ID!) {
    productVariant(id: $id) {
      id
      title
      sku
      price
      compareAtPrice
      inventoryQuantity
      availableForSale
      product {
        id
        title
        handle
        vendor
        productType
        status
        description
        descriptionHtml
        tags
      }
    }
  }
`;

const REPAIR_PRODUCT_BY_ID_QUERY = `
  query RepairProductById($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      vendor
      productType
      status
      description
      descriptionHtml
      tags
    }
  }
`;

function variantPriceStrings(variant: Record<string, unknown>): { price: string | null; compareAtPrice: string | null } {
  const priceField = variant.price as string | { amount?: string } | null | undefined;
  const compareField = variant.compareAtPrice as string | { amount?: string } | null | undefined;
  const priceV2 = variant.priceV2 as { amount?: string } | undefined;
  const compareAtPriceV2 = variant.compareAtPriceV2 as { amount?: string } | undefined;

  const priceAmount =
    typeof priceField === 'string'
      ? priceField
      : priceField?.amount ?? priceV2?.amount ?? null;
  const compareAtAmount =
    typeof compareField === 'string'
      ? compareField
      : compareField?.amount ?? compareAtPriceV2?.amount ?? null;

  const price = priceAmount != null ? String(priceAmount) : null;
  const compareAtPrice = compareAtAmount != null ? String(compareAtAmount) : null;
  return { price, compareAtPrice };
}

@Injectable()
export class ShopifyProductSyncService {
  private readonly logger = new Logger(ShopifyProductSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopifyClient: ShopifyClientService,
  ) {}

  async syncProducts(
    tenantId: string,
    agentId: string,
  ): Promise<{ syncedProducts: number; syncedVariants: number; shopDomain: string }> {
    const { domain, token } = await this.shopifyClient.getAgentShopifyConfig(tenantId, agentId);

    const productListQuery = `
      query ProductSyncPage($first: Int!, $after: String) {
        products(first: $first, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            title
            handle
            vendor
            productType
            status
            description
            descriptionHtml
            tags
            metafields(first: 25) {
              nodes {
                namespace
                key
                value
              }
            }
          }
        }
      }
    `;

    const variantPageQuery = `
      query ProductVariantsPage($id: ID!, $first: Int!, $after: String) {
        product(id: $id) {
          id
          variants(first: $first, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              title
              sku
              price
              compareAtPrice
              inventoryQuantity
              availableForSale
              metafields(first: 25) {
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
    `;

    let syncedProducts = 0;
    let syncedVariants = 0;
    let hasNextPage = true;
    let cursor: string | null = null;
    let productPageCount = 0;
    const seenProductCursors = new Set<string>();

    type ProductNode = {
      id: string;
      title?: string;
      handle?: string;
      vendor?: string;
      productType?: string;
      status?: string;
      description?: string;
      descriptionHtml?: string;
      tags?: string[] | string;
    };

    type ProductPage = {
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ProductNode[];
      };
    };

    while (hasNextPage) {
      if (productPageCount >= MAX_PRODUCT_SYNC_PAGES) {
        throw new Error(`Shopify product sync aborted: exceeded ${MAX_PRODUCT_SYNC_PAGES} pages.`);
      }
      let data: ProductPage;
      try {
        data = await this.shopifyClient.adminGraphql<ProductPage>(domain, token, productListQuery, {
          first: PRODUCTS_PAGE_SIZE,
          after: cursor,
        });
      } catch (err) {
        this.logSyncFailure('product_page', tenantId, agentId, domain, err);
        throw err;
      }

      for (const product of data.products.nodes) {
        const productId = String(product.id ?? '');
        if (!productId) continue;

        if (SYNC_THROTTLE_MS) await sleep(SYNC_THROTTLE_MS);

        const variants = await this.fetchAllVariantNodes(domain, token, variantPageQuery, productId);

        try {
          const cached = await this.prisma.productCache.upsert({
            where: {
              tenantId_agentId_shopifyProductId: { tenantId, agentId, shopifyProductId: productId },
            },
            create: {
              tenantId,
              agentId,
              shopDomain: domain,
              shopifyProductId: productId,
              handle: String(product.handle ?? ''),
              title: String(product.title ?? 'Untitled'),
              vendor: String(product.vendor ?? ''),
              productType: String(product.productType ?? ''),
              status: String(product.status ?? ''),
              bodyHtml:
                product.descriptionHtml != null
                  ? String(product.descriptionHtml)
                  : product.description != null
                    ? String(product.description)
                    : null,
              tags: Array.isArray(product.tags)
                ? (product.tags as string[]).join(',')
                : String(product.tags ?? ''),
              rawJson: { ...product, variants: { nodes: variants } } as unknown as Prisma.InputJsonValue,
            },
            update: {
              shopDomain: domain,
              handle: String(product.handle ?? ''),
              title: String(product.title ?? 'Untitled'),
              vendor: String(product.vendor ?? ''),
              productType: String(product.productType ?? ''),
              status: String(product.status ?? ''),
              bodyHtml:
                product.descriptionHtml != null
                  ? String(product.descriptionHtml)
                  : product.description != null
                    ? String(product.description)
                    : null,
              tags: Array.isArray(product.tags)
                ? (product.tags as string[]).join(',')
                : String(product.tags ?? ''),
              rawJson: { ...product, variants: { nodes: variants } } as unknown as Prisma.InputJsonValue,
              syncedAt: new Date(),
            },
          });
          syncedProducts += 1;

          for (const variant of variants) {
            const variantId = String(variant.id ?? '');
            if (!variantId) continue;
            const { price, compareAtPrice } = variantPriceStrings(variant);
            await this.prisma.variantCache.upsert({
              where: { tenantId_shopifyVariantId: { tenantId, shopifyVariantId: variantId } },
              create: {
                tenantId,
                productCacheId: cached.id,
                shopifyVariantId: variantId,
                title: String(variant.title ?? ''),
                sku: variant.sku != null ? String(variant.sku) : null,
                price: price ?? undefined,
                compareAtPrice: compareAtPrice ?? undefined,
                inventoryQuantity: Number(variant.inventoryQuantity ?? 0),
                availableForSale: Boolean(variant.availableForSale),
                rawJson: variant as unknown as Prisma.InputJsonValue,
              },
              update: {
                productCacheId: cached.id,
                title: String(variant.title ?? ''),
                sku: variant.sku != null ? String(variant.sku) : null,
                price: price ?? undefined,
                compareAtPrice: compareAtPrice ?? undefined,
                inventoryQuantity: Number(variant.inventoryQuantity ?? 0),
                availableForSale: Boolean(variant.availableForSale),
                rawJson: variant as unknown as Prisma.InputJsonValue,
                syncedAt: new Date(),
              },
            });
            syncedVariants += 1;
          }
          const syncedVariantIds = variants
            .map((variant) => String(variant.id ?? '').trim())
            .filter((id) => id.length > 0);
          await this.prisma.variantCache.deleteMany({
            where: {
              tenantId,
              productCacheId: cached.id,
              ...(syncedVariantIds.length > 0
                ? { shopifyVariantId: { notIn: syncedVariantIds } }
                : {}),
            },
          });
        } catch (err) {
          this.logger.error(
            JSON.stringify({
              event: 'shopify.sync.product_upsert_failed',
              tenantId,
              agentId,
              shopDomain: domain,
              productId,
              message: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
            }),
          );
          throw err;
        }
      }

      hasNextPage = data.products.pageInfo.hasNextPage;
      cursor = data.products.pageInfo.endCursor;
      productPageCount += 1;
      if (cursor) {
        if (seenProductCursors.has(cursor)) {
          throw new Error('Shopify product sync aborted: repeated product pagination cursor detected.');
        }
        seenProductCursors.add(cursor);
      }
    }

    this.logger.log(
      JSON.stringify({
        event: 'shopify.sync.completed',
        tenantId,
        agentId,
        shopDomain: domain,
        syncedProducts,
        syncedVariants,
      }),
    );

    return { syncedProducts, syncedVariants, shopDomain: domain };
  }

  /**
   * Fetch one product (and its variants) from Shopify Admin and upsert local ProductCache / VariantCache.
   * Used when checkout references a variant that exists live but is missing or stale in cache.
   */
  async repairVariantCacheFromShopify(
    tenantId: string,
    agentId: string,
    shopDomain: string,
    rawKey: string,
  ): Promise<RepairedVariantCacheRow | null> {
    const { domain, token } = await this.shopifyClient.getAgentShopifyConfig(tenantId, agentId);
    const normalizedDomain = domain || shopDomain;
    const variantKeys = variantIdLookupKeys(rawKey);
    const productKeys = productIdLookupKeys(rawKey);
    const targetVariantGid =
      variantKeys.find((k) => k.startsWith('gid://shopify/ProductVariant/')) ?? toProductVariantGid(rawKey);

    let productNode: Record<string, unknown> | null = null;
    let variantNodes: Array<Record<string, unknown>> = [];
    let preferredVariantId = targetVariantGid;

    if (variantKeys.some((k) => k.includes('ProductVariant') || /^\d+$/.test(k))) {
      try {
        const data = await this.shopifyClient.adminGraphql<{
          productVariant: Record<string, unknown> | null;
        }>(normalizedDomain, token, REPAIR_VARIANT_BY_ID_QUERY, { id: targetVariantGid });
        const pv = data.productVariant;
        if (pv?.product && typeof pv.product === 'object') {
          productNode = pv.product as Record<string, unknown>;
          variantNodes = [pv];
          preferredVariantId = String(pv.id ?? targetVariantGid);
        }
      } catch (err) {
        this.logSyncFailure('repair_variant', tenantId, agentId, normalizedDomain, err, targetVariantGid);
      }
    }

    if (!productNode && productKeys.length > 0) {
      const productGid = productKeys.find((k) => k.startsWith('gid://shopify/Product/')) ?? toProductGid(rawKey);
      try {
        const data = await this.shopifyClient.adminGraphql<{ product: Record<string, unknown> | null }>(
          normalizedDomain,
          token,
          REPAIR_PRODUCT_BY_ID_QUERY,
          { id: productGid },
        );
        productNode = data.product;
        if (productNode?.id) {
          const variantPageQuery = `
            query ProductVariantsPage($id: ID!, $first: Int!, $after: String) {
              product(id: $id) {
                id
                variants(first: $first, after: $after) {
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    id
                    title
                    sku
                    price
                    compareAtPrice
                    inventoryQuantity
                    availableForSale
                  }
                }
              }
            }
          `;
          variantNodes = await this.fetchAllVariantNodes(
            normalizedDomain,
            token,
            variantPageQuery,
            String(productNode.id),
          );
        }
      } catch (err) {
        this.logSyncFailure('repair_product', tenantId, agentId, normalizedDomain, err, productGid);
      }
    }

    if (!productNode || variantNodes.length === 0) {
      this.logger.warn(
        JSON.stringify({
          event: 'shopify.sync.repair_no_match',
          tenantId,
          agentId,
          shopDomain: normalizedDomain,
          rawKey: rawKey.slice(0, 80),
        }),
      );
      return null;
    }

    const productId = String(productNode.id ?? '');
    if (!productId) return null;

    const cached = await this.upsertProductCacheRow(tenantId, agentId, normalizedDomain, productNode, variantNodes);
    const syncedVariantIds = variantNodes
      .map((variant) => String(variant.id ?? '').trim())
      .filter((id) => id.length > 0);
    await this.prisma.variantCache.deleteMany({
      where: {
        tenantId,
        productCacheId: cached.id,
        ...(syncedVariantIds.length > 0 ? { shopifyVariantId: { notIn: syncedVariantIds } } : {}),
      },
    });

    const lookupIds = new Set(variantIdLookupKeys(preferredVariantId));
    return this.prisma.variantCache.findFirst({
      where: {
        tenantId,
        shopifyVariantId: { in: [...lookupIds] },
        productCacheId: cached.id,
      },
      include: { product: { select: { title: true, shopifyProductId: true } } },
    });
  }

  private async upsertProductCacheRow(
    tenantId: string,
    agentId: string,
    domain: string,
    product: Record<string, unknown>,
    variants: Array<Record<string, unknown>>,
  ) {
    const productId = String(product.id ?? '');
    const cached = await this.prisma.productCache.upsert({
      where: {
        tenantId_agentId_shopifyProductId: { tenantId, agentId, shopifyProductId: productId },
      },
      create: {
        tenantId,
        agentId,
        shopDomain: domain,
        shopifyProductId: productId,
        handle: String(product.handle ?? ''),
        title: String(product.title ?? 'Untitled'),
        vendor: String(product.vendor ?? ''),
        productType: String(product.productType ?? ''),
        status: String(product.status ?? ''),
        bodyHtml:
          product.descriptionHtml != null
            ? String(product.descriptionHtml)
            : product.description != null
              ? String(product.description)
              : null,
        tags: Array.isArray(product.tags)
          ? (product.tags as string[]).join(',')
          : String(product.tags ?? ''),
        rawJson: { ...product, variants: { nodes: variants } } as unknown as Prisma.InputJsonValue,
      },
      update: {
        shopDomain: domain,
        handle: String(product.handle ?? ''),
        title: String(product.title ?? 'Untitled'),
        vendor: String(product.vendor ?? ''),
        productType: String(product.productType ?? ''),
        status: String(product.status ?? ''),
        bodyHtml:
          product.descriptionHtml != null
            ? String(product.descriptionHtml)
            : product.description != null
              ? String(product.description)
              : null,
        tags: Array.isArray(product.tags)
          ? (product.tags as string[]).join(',')
          : String(product.tags ?? ''),
        rawJson: { ...product, variants: { nodes: variants } } as unknown as Prisma.InputJsonValue,
        syncedAt: new Date(),
      },
    });

    for (const variant of variants) {
      const variantId = String(variant.id ?? '');
      if (!variantId) continue;
      const { price, compareAtPrice } = variantPriceStrings(variant);
      await this.prisma.variantCache.upsert({
        where: { tenantId_shopifyVariantId: { tenantId, shopifyVariantId: variantId } },
        create: {
          tenantId,
          productCacheId: cached.id,
          shopifyVariantId: variantId,
          title: String(variant.title ?? ''),
          sku: variant.sku != null ? String(variant.sku) : null,
          price: price ?? undefined,
          compareAtPrice: compareAtPrice ?? undefined,
          inventoryQuantity: Number(variant.inventoryQuantity ?? 0),
          availableForSale: Boolean(variant.availableForSale),
          rawJson: variant as unknown as Prisma.InputJsonValue,
        },
        update: {
          productCacheId: cached.id,
          title: String(variant.title ?? ''),
          sku: variant.sku != null ? String(variant.sku) : null,
          price: price ?? undefined,
          compareAtPrice: compareAtPrice ?? undefined,
          inventoryQuantity: Number(variant.inventoryQuantity ?? 0),
          availableForSale: Boolean(variant.availableForSale),
          rawJson: variant as unknown as Prisma.InputJsonValue,
          syncedAt: new Date(),
        },
      });
    }

    return cached;
  }

  private async fetchAllVariantNodes(
    domain: string,
    token: string,
    query: string,
    productGid: string,
  ): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let vCursor: string | null = null;
    let vHasNext = true;
    let variantPageCount = 0;
    const seenVariantCursors = new Set<string>();

    type VariantPage = {
      product: {
        id: string;
        variants: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<Record<string, unknown>>;
        };
      } | null;
    };

    while (vHasNext) {
      if (variantPageCount >= MAX_VARIANT_SYNC_PAGES) {
        throw new Error(`Shopify variant sync aborted: exceeded ${MAX_VARIANT_SYNC_PAGES} pages for product ${productGid}.`);
      }
      let data: VariantPage;
      try {
        data = await this.shopifyClient.adminGraphql<VariantPage>(domain, token, query, {
          id: productGid,
          first: VARIANTS_PAGE_SIZE,
          after: vCursor,
        });
      } catch (err) {
        this.logSyncFailure('variant_page', undefined, undefined, domain, err, productGid);
        throw err;
      }

      const productNode = data.product;
      if (!productNode) {
        this.logger.warn(
          JSON.stringify({
            event: 'shopify.sync.product_missing_mid_sync',
            shopDomain: domain,
            productGid,
          }),
        );
        break;
      }

      const conn = productNode.variants;
      out.push(...conn.nodes);
      vHasNext = conn.pageInfo.hasNextPage;
      vCursor = conn.pageInfo.endCursor;
      variantPageCount += 1;
      if (vCursor) {
        if (seenVariantCursors.has(vCursor)) {
          throw new Error(`Shopify variant sync aborted: repeated variant pagination cursor for product ${productGid}.`);
        }
        seenVariantCursors.add(vCursor);
      }

      if (SYNC_THROTTLE_MS && vHasNext) await sleep(SYNC_THROTTLE_MS);
    }

    return out;
  }

  private logSyncFailure(
    phase: string,
    tenantId: string | undefined,
    agentId: string | undefined,
    domain: string,
    err: unknown,
    productGid?: string,
  ) {
    const base = {
      event: 'shopify.sync.failed',
      phase,
      tenantId: tenantId ?? null,
      agentId: agentId ?? null,
      shopDomain: domain,
      productGid: productGid ?? null,
    };
    if (err instanceof ShopifyGraphqlError) {
      this.logger.error(
        JSON.stringify({
          ...base,
          retryable: err.retryable,
          status: err.status,
          graphql: err.summary().slice(0, 500),
        }),
      );
    } else {
      this.logger.error(
        JSON.stringify({
          ...base,
          message: err instanceof Error ? err.message.slice(0, 400) : 'unknown_error',
        }),
      );
    }
  }
}
