import { Injectable } from '@nestjs/common';
import { ShopifyClientService } from '../integrations/shopify/client';
import { toProductVariantGid } from '../integrations/shopify/shopify-ids';

const VOICE_PAYMENT_VARIANT_QUERY = `
  query VoicePaymentVariant($id: ID!) {
    productVariant(id: $id) {
      id
      title
      price
      product {
        title
      }
    }
  }
`;

export type VoicePaymentLineItem = {
  title: string;
  quantity: number;
  price: string | null;
  variantId: string;
};

@Injectable()
export class VoicePaymentCatalogService {
  constructor(private readonly shopifyClient: ShopifyClientService) {}

  async resolveLineItem(
    tenantId: string,
    agentId: string,
    variantId: string,
    quantity: number,
  ): Promise<VoicePaymentLineItem> {
    const variantGid = toProductVariantGid(variantId);
    const qty = Math.max(1, Math.min(99, Math.floor(quantity || 1)));

    try {
      const { domain, token, apiVersion } = await this.shopifyClient.getAgentShopifyConfig(
        tenantId,
        agentId,
      );
      const data = await this.shopifyClient.adminGraphql<{
        productVariant?: {
          id: string;
          title?: string | null;
          price?: string | null;
          product?: { title?: string | null } | null;
        } | null;
      }>(domain, token, VOICE_PAYMENT_VARIANT_QUERY, { id: variantGid }, apiVersion);

      const variant = data.productVariant;
      const productTitle = variant?.product?.title?.trim();
      const variantTitle = variant?.title?.trim();
      const title =
        productTitle && variantTitle && variantTitle !== 'Default Title'
          ? `${productTitle} — ${variantTitle}`
          : productTitle || variantTitle || 'Selected item';

      const priceRaw = variant?.price;
      const price =
        priceRaw != null && priceRaw !== ''
          ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
              Number(priceRaw),
            )
          : null;

      return { title, quantity: qty, price, variantId: variantGid };
    } catch {
      return { title: 'Selected item', quantity: qty, price: null, variantId: variantGid };
    }
  }
}
