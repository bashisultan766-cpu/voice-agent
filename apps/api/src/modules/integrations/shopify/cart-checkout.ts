import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ShopifyClientService } from './client';
import { ShopifyCheckoutValidationError } from './shopify-errors';

export type StorefrontResolvedLine = {
  variantGid: string;
  storefrontVariantId: string;
  quantity: number;
  title?: string;
  sku?: string | null;
};

@Injectable()
export class ShopifyCartCheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: ShopifyClientService,
  ) {}

  async createStorefrontCartCheckout(
    tenantId: string,
    agentId: string,
    payload: {
      callSessionId?: string;
      email: string;
      lines: StorefrontResolvedLine[];
      checkoutFingerprint: string;
      metadata: Prisma.InputJsonValue;
    },
  ) {
    const customerEmail = payload.email.trim();
    if (!customerEmail) {
      throw new ShopifyCheckoutValidationError(
        'EMAIL_REQUIRED',
        'Customer email is required before creating a checkout URL.',
      );
    }
    const normalizedItems = payload.lines
      .map((item) => ({
        storefrontVariantId: item.storefrontVariantId.trim(),
        quantity: Math.max(1, item.quantity || 1),
        variantGid: item.variantGid,
        title: item.title,
        sku: item.sku,
      }))
      .filter((item) => item.storefrontVariantId.length > 0);
    if (normalizedItems.length === 0) {
      throw new ShopifyCheckoutValidationError(
        'NO_LINE_ITEMS',
        'At least one valid variant is required to create checkout.',
      );
    }

    const { domain, shopifyConnectionId } = await this.client.getAgentShopifyConfig(tenantId, agentId);
    const cartPath = normalizedItems
      .map((item) => `${encodeURIComponent(item.storefrontVariantId)}:${Math.max(1, item.quantity)}`)
      .join(',');
    const checkoutUrl = `https://${domain}/cart/${cartPath}?checkout[email]=${encodeURIComponent(customerEmail)}`;

    const link = await this.prisma.checkoutLink.create({
      data: {
        tenantId,
        agentId,
        callSessionId: payload.callSessionId ?? null,
        checkoutFingerprint: payload.checkoutFingerprint,
        shopifyConnectionId,
        mode: 'STOREFRONT_CART',
        checkoutUrl,
        customerEmail,
        itemsJson: normalizedItems as unknown as Prisma.InputJsonValue,
        status: 'CREATED',
        metadata: payload.metadata,
      },
    });
    return link;
  }
}
