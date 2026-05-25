import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ShopifyCartCheckoutService } from './cart-checkout';
import { ShopifyDraftOrderService } from './draft-order';
import { ShopifyClientService } from './client';
import {
  productIdLookupKeys,
  variantIdLookupKeys,
  toProductVariantGid,
  toStorefrontCartVariantId,
} from './shopify-ids';
import { ShopifyCheckoutValidationError } from './shopify-errors';

export interface CheckoutLinkCreateResult {
  checkoutUrl: string;
  itemCount: number;
  checkoutLinkId: string;
  mode: 'STOREFRONT_CART' | 'DRAFT_ORDER_INVOICE';
  reusedExisting?: boolean;
}

interface CheckoutItem {
  productId?: string;
  variantId?: string;
  title?: string;
  quantity: number;
  sku?: string;
}

interface CheckoutCustomer {
  name?: string;
  phone?: string;
  email?: string;
}

interface DeliveryAddress {
  addressLine1?: string;
  city?: string;
  postalCode?: string;
  country?: string;
}

type ResolvedLine = {
  variantGid: string;
  storefrontVariantId: string;
  quantity: number;
  title?: string;
  sku?: string | null;
};

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}

@Injectable()
export class ShopifyCheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shopifyClient: ShopifyClientService,
    private readonly cartCheckout: ShopifyCartCheckoutService,
    private readonly draftOrderCheckout: ShopifyDraftOrderService,
  ) {}

  /**
   * Voice-safe checkout: Shopify-hosted payment. Line items are validated against ProductCache
   * so permalinks and draft invoices are not built from hallucinated SKUs.
   */
  async createCheckoutLink(
    tenantId: string,
    agentId: string,
    input: {
      items: CheckoutItem[];
      customer?: CheckoutCustomer;
      deliveryAddress?: DeliveryAddress;
      callSessionId?: string;
      mode?: 'STOREFRONT_CART' | 'DRAFT_ORDER_INVOICE';
      note?: string;
      forceNewCheckout?: boolean;
    },
  ): Promise<CheckoutLinkCreateResult> {
    const customerEmail = input.customer?.email?.trim();
    if (!customerEmail) {
      throw new ShopifyCheckoutValidationError(
        'EMAIL_REQUIRED',
        'Customer email is required before creating checkout.',
      );
    }

    const { domain, shopifyConnectionId } = await this.shopifyClient.getAgentShopifyConfig(tenantId, agentId);

    const rawRows = (input.items ?? [])
      .map((i) => ({
        variantKey: (i.variantId || i.productId || '').trim(),
        sku: (i.sku || '').trim(),
        title: (i.title || '').trim(),
        quantity: Math.max(1, Number(i.quantity) || 1),
      }))
      .filter((i) => i.variantKey.length > 0 || i.sku.length > 0 || i.title.length > 0);

    if (rawRows.length === 0) {
      throw new ShopifyCheckoutValidationError(
        'NO_LINE_ITEMS',
        'Cannot create checkout without at least one catalog variant or product id.',
      );
    }

    const lines: ResolvedLine[] = [];
    for (const row of rawRows) {
      lines.push(
        await this.resolveLineFromCache(tenantId, agentId, domain, row.variantKey || row.sku || row.title, row.quantity),
      );
    }
    const aggregated = new Map<string, ResolvedLine>();
    for (const line of lines) {
      const key = line.variantGid;
      const current = aggregated.get(key);
      if (!current) {
        aggregated.set(key, { ...line });
      } else {
        current.quantity += line.quantity;
      }
    }
    const dedupedLines = [...aggregated.values()];

    const configuredMode = await this.prisma.agentConfig.findUnique({
      where: { agentId },
      select: { checkoutMode: true },
    });
    const mode = input.mode ?? configuredMode?.checkoutMode ?? 'STOREFRONT_CART';

    const fingerprint = this.buildFingerprint(
      mode,
      customerEmail,
      dedupedLines.map((l) => ({ variantGid: l.variantGid, quantity: l.quantity })),
    );

    const existing = await this.findReusableCheckoutLink(
      tenantId,
      agentId,
      input.callSessionId,
      fingerprint,
      input.forceNewCheckout === true,
    );
    if (existing) {
      const itemCount = Array.isArray(existing.itemsJson)
        ? (existing.itemsJson as unknown[]).length
        : dedupedLines.length;
      return {
        checkoutUrl: existing.checkoutUrl,
        itemCount,
        checkoutLinkId: existing.id,
        mode: existing.mode as 'STOREFRONT_CART' | 'DRAFT_ORDER_INVOICE',
        reusedExisting: true,
      };
    }

    const metadata = {
      shopDomain: domain,
      shopifyConnectionId,
      flow: mode === 'DRAFT_ORDER_INVOICE' ? 'draft_order_invoice' : 'storefront_cart_permalink',
      customer: (input.customer ?? {}) as Record<string, unknown>,
      deliveryAddress: (input.deliveryAddress ?? {}) as Record<string, unknown>,
      resolvedAt: new Date().toISOString(),
      lineCount: lines.length,
      checkoutFingerprint: fingerprint,
      lineItems: dedupedLines.map((line) => ({
        variantGid: line.variantGid,
        storefrontVariantId: line.storefrontVariantId,
        quantity: line.quantity,
        title: line.title,
        sku: line.sku,
      })),
    } as Prisma.InputJsonValue;

    if (mode === 'DRAFT_ORDER_INVOICE') {
      const link = await this.draftOrderCheckout.createDraftOrderCheckout(tenantId, agentId, {
        callSessionId: input.callSessionId,
        email: customerEmail,
        lines: dedupedLines,
        note: input.note,
        checkoutFingerprint: fingerprint,
        metadata,
      });
      return {
        checkoutUrl: link.checkoutUrl,
        itemCount: dedupedLines.length,
        checkoutLinkId: link.id,
        mode: 'DRAFT_ORDER_INVOICE',
      };
    }

    const link = await this.cartCheckout.createStorefrontCartCheckout(tenantId, agentId, {
      callSessionId: input.callSessionId,
      email: customerEmail,
      lines: dedupedLines,
      checkoutFingerprint: fingerprint,
      metadata,
    });
    return {
      checkoutUrl: link.checkoutUrl,
      itemCount: dedupedLines.length,
      checkoutLinkId: link.id,
      mode: 'STOREFRONT_CART',
    };
  }

  private buildFingerprint(
    mode: 'STOREFRONT_CART' | 'DRAFT_ORDER_INVOICE',
    email: string,
    lines: Array<{ variantGid: string; quantity: number }>,
  ): string {
    const canonical = lines
      .map((l) => `${l.variantGid}:${l.quantity}`)
      .sort()
      .join('|');
    return createHash('sha256')
      .update(`${mode}|${email.trim().toLowerCase()}|${canonical}`)
      .digest('hex');
  }

  private async findReusableCheckoutLink(
    tenantId: string,
    agentId: string,
    callSessionId: string | undefined,
    fingerprint: string,
    forceNew: boolean,
  ) {
    if (forceNew || !callSessionId) return null;
    return this.prisma.checkoutLink.findFirst({
      where: {
        tenantId,
        agentId,
        callSessionId,
        checkoutFingerprint: fingerprint,
        status: { in: ['CREATED', 'SENT', 'OPENED'] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async resolveLineFromCache(
    tenantId: string,
    agentId: string,
    shopDomain: string,
    rawKey: string,
    quantity: number,
  ): Promise<ResolvedLine> {
    const productScope = { shopDomain, agentId };
    const variantKeys = variantIdLookupKeys(rawKey);
    let v = await this.prisma.variantCache.findFirst({
      where: {
        tenantId,
        shopifyVariantId: { in: variantKeys },
        product: productScope,
      },
      include: { product: { select: { title: true, shopifyProductId: true } } },
    });

    if (!v) {
      const skuKey = normalizeLookupKey(rawKey);
      if (skuKey.length > 0) {
        v = await this.prisma.variantCache.findFirst({
          where: {
            tenantId,
            sku: { equals: skuKey, mode: 'insensitive' },
            product: productScope,
          },
          include: { product: { select: { title: true, shopifyProductId: true } } },
          orderBy: { updatedAt: 'desc' },
        });
      }
    }

    if (!v) {
      const titleKey = rawKey.trim();
      if (titleKey.length > 0) {
        v = await this.prisma.variantCache.findFirst({
          where: {
            tenantId,
            title: { contains: titleKey, mode: 'insensitive' },
            product: productScope,
          },
          include: { product: { select: { title: true, shopifyProductId: true } } },
          orderBy: { updatedAt: 'desc' },
        });
      }
    }

    if (!v) {
      const productKeys = productIdLookupKeys(rawKey);
      v = await this.prisma.variantCache.findFirst({
        where: {
          tenantId,
          product: {
            ...productScope,
            shopifyProductId: { in: productKeys },
          },
        },
        orderBy: { updatedAt: 'desc' },
        include: { product: { select: { title: true, shopifyProductId: true } } },
      });
    }

    if (!v) {
      throw new ShopifyCheckoutValidationError(
        'VARIANT_NOT_IN_CACHE',
        `No matching variant found in the synced catalog for this store. Use search or run a catalog sync. Ref: ${rawKey.slice(0, 64)}`,
      );
    }
    if (!v.availableForSale || (v.inventoryQuantity ?? 0) <= 0) {
      throw new ShopifyCheckoutValidationError(
        'VARIANT_UNAVAILABLE',
        `The selected variant is currently unavailable for sale. Please choose another option.`,
      );
    }

    const variantGid = toProductVariantGid(v.shopifyVariantId);
    const storefrontVariantId = toStorefrontCartVariantId(v.shopifyVariantId);
    const pTitle = v.product?.title;
    const vTitle = v.title;
    const title =
      pTitle && vTitle && vTitle !== 'Default Title'
        ? `${pTitle} — ${vTitle}`
        : pTitle || vTitle || undefined;

    return {
      variantGid,
      storefrontVariantId,
      quantity: Math.max(1, quantity),
      title,
      sku: v.sku,
    };
  }
}
