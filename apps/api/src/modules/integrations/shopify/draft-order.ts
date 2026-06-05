import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ShopifyClientService } from './client';
import { ShopifyCheckoutValidationError } from './shopify-errors';
import { extractTrailingNumericId, toProductVariantGid } from './shopify-ids';

export type DraftResolvedLine = {
  variantGid: string;
  storefrontVariantId: string;
  quantity: number;
  title?: string;
  sku?: string | null;
};

export type DraftOrderPaymentLinkResult = {
  draftOrderId: string;
  invoiceUrl: string;
  shopifyInvoiceSent: boolean;
  shopifyInvoiceError?: string;
  shopifyConnectionId: string | null;
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

  /**
   * Create a draft order and email the invoice/payment link (voice agent hot path).
   */
  async sendDraftOrderPaymentLink(
    tenantId: string,
    agentId: string,
    payload: { email: string; variantId: string; quantity: number },
  ): Promise<DraftOrderPaymentLinkResult> {
    return this.sendAggregatedDraftOrderPaymentLink(tenantId, agentId, {
      email: payload.email,
      lines: [{ variantId: payload.variantId, quantity: payload.quantity }],
    });
  }

  /**
   * Create or update a draft order with multiple line items (aggregated by recipient email).
   */
  async sendAggregatedDraftOrderPaymentLink(
    tenantId: string,
    agentId: string,
    payload: {
      email: string;
      lines: Array<{ variantId: string; quantity: number }>;
      existingDraftOrderId?: string | null;
      sendShopifyInvoice?: boolean;
    },
  ): Promise<DraftOrderPaymentLinkResult> {
    const customerEmail = payload.email.trim().toLowerCase();
    if (!customerEmail) {
      throw new ShopifyCheckoutValidationError(
        'EMAIL_REQUIRED',
        'Customer email is required before sending a payment link.',
      );
    }

    const normalizedLines = payload.lines
      .map((line) => {
        const variantGid = toProductVariantGid(line.variantId);
        const variantNumericId = extractTrailingNumericId(variantGid);
        if (!variantGid.startsWith('gid://shopify/ProductVariant/') || !variantNumericId || variantNumericId === '0') {
          return null;
        }
        return {
          variantGid,
          quantity: Math.max(1, Math.min(99, Math.floor(line.quantity || 1))),
        };
      })
      .filter((line): line is { variantGid: string; quantity: number } => line != null);

    if (normalizedLines.length === 0) {
      throw new ShopifyCheckoutValidationError(
        'INVALID_VARIANT_ID',
        'At least one valid Shopify product variant is required.',
      );
    }

    const { domain, token, apiVersion, shopifyConnectionId } = await this.client.getAgentShopifyConfig(
      tenantId,
      agentId,
    );

    const lineItemsInput = normalizedLines.map((line) => ({
      variantId: line.variantGid,
      quantity: line.quantity,
    }));

    const existingDraftOrderId = payload.existingDraftOrderId?.trim() || null;
    let draftOrderId: string | null = null;
    let invoiceUrlFromMutation: string | null = null;

    if (existingDraftOrderId) {
      const updateMutation = `
        mutation DraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
          draftOrderUpdate(id: $id, input: $input) {
            draftOrder { id invoiceUrl }
            userErrors { field message }
          }
        }
      `;
      const updateData = await this.client.adminGraphql<{
        draftOrderUpdate: {
          draftOrder?: { id: string; invoiceUrl?: string | null };
          userErrors?: Array<{ field?: string[]; message?: string }>;
        };
      }>(
        domain,
        token,
        updateMutation,
        {
          id: existingDraftOrderId,
          input: {
            email: customerEmail,
            lineItems: lineItemsInput,
          },
        },
        apiVersion,
      );
      const updateErrors = updateData.draftOrderUpdate.userErrors ?? [];
      if (updateErrors.length) {
        const msg =
          updateErrors.map((e) => e.message).filter(Boolean).join('; ') ||
          'Draft order could not be updated.';
        throw new ShopifyCheckoutValidationError('DRAFT_ORDER_USER_ERROR', msg);
      }
      draftOrderId = updateData.draftOrderUpdate.draftOrder?.id ?? existingDraftOrderId;
      invoiceUrlFromMutation = updateData.draftOrderUpdate.draftOrder?.invoiceUrl ?? null;
    } else {
      const createMutation = `
        mutation DraftOrderCreate($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder { id invoiceUrl }
            userErrors { field message }
          }
        }
      `;
      const createData = await this.client.adminGraphql<{
        draftOrderCreate: {
          draftOrder?: { id: string; invoiceUrl?: string | null };
          userErrors?: Array<{ field?: string[]; message?: string }>;
        };
      }>(
        domain,
        token,
        createMutation,
        {
          input: {
            email: customerEmail,
            lineItems: lineItemsInput,
          },
        },
        apiVersion,
      );

      const createErrors = createData.draftOrderCreate.userErrors ?? [];
      if (createErrors.length) {
        const msg =
          createErrors.map((e) => e.message).filter(Boolean).join('; ') ||
          'Draft order could not be created.';
        throw new ShopifyCheckoutValidationError('DRAFT_ORDER_USER_ERROR', msg);
      }

      draftOrderId = createData.draftOrderCreate.draftOrder?.id ?? null;
      invoiceUrlFromMutation = createData.draftOrderCreate.draftOrder?.invoiceUrl ?? null;
    }

    if (!draftOrderId) {
      throw new ShopifyCheckoutValidationError(
        'DRAFT_ORDER_MISSING_ID',
        'Draft order was created but Shopify did not return a draft order id.',
      );
    }

    const shouldSendShopifyInvoice = payload.sendShopifyInvoice !== false;
    const invoiceSendMutation = `
      mutation DraftOrderInvoiceSend($id: ID!, $email: EmailInput) {
        draftOrderInvoiceSend(id: $id, email: $email) {
          draftOrder { id invoiceUrl }
          userErrors { field message }
        }
      }
    `;

    let shopifyInvoiceSent = false;
    let shopifyInvoiceError: string | undefined;
    let invoiceUrlFromSend: string | null = null;

    if (shouldSendShopifyInvoice) {
      try {
        const invoiceData = await this.client.adminGraphql<{
          draftOrderInvoiceSend: {
            draftOrder?: { id: string; invoiceUrl?: string | null };
            userErrors?: Array<{ field?: string[]; message?: string }>;
          };
        }>(
          domain,
          token,
          invoiceSendMutation,
          {
            id: draftOrderId,
            email: { to: customerEmail },
          },
          apiVersion,
        );

        const invoiceErrors = invoiceData.draftOrderInvoiceSend.userErrors ?? [];
        if (invoiceErrors.length) {
          shopifyInvoiceError =
            invoiceErrors.map((e) => e.message).filter(Boolean).join('; ') ||
            'Draft order invoice could not be sent.';
        } else {
          shopifyInvoiceSent = true;
          invoiceUrlFromSend = invoiceData.draftOrderInvoiceSend.draftOrder?.invoiceUrl ?? null;
        }
      } catch (err) {
        shopifyInvoiceError = err instanceof Error ? err.message : String(err);
      }
    }

    const invoiceUrl = invoiceUrlFromSend ?? invoiceUrlFromMutation;
    if (!invoiceUrl) {
      throw new ShopifyCheckoutValidationError(
        'DRAFT_ORDER_NO_INVOICE_URL',
        'Draft order was created but Shopify did not return an invoice URL.',
      );
    }

    return {
      draftOrderId,
      invoiceUrl,
      shopifyInvoiceSent,
      shopifyInvoiceError,
      shopifyConnectionId,
    };
  }
}
