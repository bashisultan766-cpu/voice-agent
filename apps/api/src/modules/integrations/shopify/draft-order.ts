import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ShopifyClientService } from './client';
import { ShopifyCheckoutValidationError } from './shopify-errors';
import { toProductVariantGid } from './shopify-ids';

export type DraftResolvedLine = {
  variantGid: string;
  storefrontVariantId: string;
  quantity: number;
  title?: string;
  sku?: string | null;
};

@Injectable()
export class ShopifyDraftOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: ShopifyClientService,
  ) {}

  async createDraftOrderCheckout(
    tenantId: string,
    agentId: string,
    payload: {
      callSessionId?: string;
      email: string;
      lines: DraftResolvedLine[];
      note?: string;
      checkoutFingerprint: string;
      metadata: Prisma.InputJsonValue;
    },
  ) {
    const customerEmail = payload.email.trim();
    if (!customerEmail) {
      throw new ShopifyCheckoutValidationError(
        'EMAIL_REQUIRED',
        'Customer email is required before creating draft order invoice.',
      );
    }
    const normalizedItems = payload.lines
      .map((item) => ({
        variantGid: toProductVariantGid(item.variantGid),
        quantity: Math.max(1, item.quantity || 1),
        storefrontVariantId: item.storefrontVariantId,
        title: item.title,
        sku: item.sku,
      }))
      .filter((item) => item.variantGid.length > 0);
    if (normalizedItems.length === 0) {
      throw new ShopifyCheckoutValidationError(
        'NO_LINE_ITEMS',
        'At least one valid variant is required to create draft order invoice.',
      );
    }

    const { domain, token, shopifyConnectionId } = await this.client.getAgentShopifyConfig(
      tenantId,
      agentId,
    );
    const mutation = `
      mutation DraftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id invoiceUrl }
          userErrors { field message }
        }
      }
    `;
    const data = await this.client.adminGraphql<{
      draftOrderCreate: {
        draftOrder?: { id: string; invoiceUrl?: string | null };
        userErrors?: Array<{ field?: string[]; message?: string }>;
      };
    }>(domain, token, mutation, {
      input: {
        email: customerEmail,
        lineItems: normalizedItems.map((item) => ({
          variantId: item.variantGid,
          quantity: Math.max(1, item.quantity),
        })),
        note: payload.note,
      },
    });

    const userErrors = data.draftOrderCreate.userErrors ?? [];
    if (userErrors.length) {
      const msg = userErrors.map((e) => e.message).filter(Boolean).join('; ') || 'Draft order could not be created.';
      throw new ShopifyCheckoutValidationError('DRAFT_ORDER_USER_ERROR', msg);
    }

    const invoiceUrl = data.draftOrderCreate.draftOrder?.invoiceUrl;
    if (!invoiceUrl) {
      throw new ShopifyCheckoutValidationError(
        'DRAFT_ORDER_NO_INVOICE_URL',
        'Draft order was created but Shopify did not return an invoice URL.',
      );
    }

    return this.prisma.checkoutLink.create({
      data: {
        tenantId,
        agentId,
        callSessionId: payload.callSessionId ?? null,
        checkoutFingerprint: payload.checkoutFingerprint,
        shopifyConnectionId,
        mode: 'DRAFT_ORDER_INVOICE',
        checkoutUrl: invoiceUrl,
        customerEmail,
        itemsJson: normalizedItems as unknown as Prisma.InputJsonValue,
        providerRef: data.draftOrderCreate.draftOrder?.id ?? null,
        status: 'CREATED',
        metadata: (() => {
          const base =
            payload.metadata &&
            typeof payload.metadata === 'object' &&
            !Array.isArray(payload.metadata)
              ? { ...(payload.metadata as Record<string, unknown>) }
              : {};
          return {
            ...base,
            draftOrderId: data.draftOrderCreate.draftOrder?.id ?? null,
            invoiceUrl,
          } as Prisma.InputJsonValue;
        })(),
      },
    });
  }
}
