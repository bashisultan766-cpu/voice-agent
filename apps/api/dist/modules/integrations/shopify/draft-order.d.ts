import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ShopifyClientService } from './client';
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
export declare class ShopifyDraftOrderService {
    private readonly prisma;
    private readonly client;
    private readonly logger;
    constructor(prisma: PrismaService, client: ShopifyClientService);
    private logShopifyEmailUserErrors;
    createDraftOrderCheckout(tenantId: string, agentId: string, payload: {
        callSessionId?: string;
        email: string;
        lines: DraftResolvedLine[];
        note?: string;
        checkoutFingerprint: string;
        metadata: Prisma.InputJsonValue;
    }): Promise<{
        id: string;
        createdAt: Date;
        tenantId: string;
        agentId: string;
        customerEmail: string | null;
        updatedAt: Date;
        callSessionId: string | null;
        status: import("@prisma/client").$Enums.CheckoutLinkStatus;
        metadata: Prisma.JsonValue | null;
        sentAt: Date | null;
        checkoutFingerprint: string | null;
        mode: import("@prisma/client").$Enums.CheckoutMode;
        checkoutUrl: string;
        itemsJson: Prisma.JsonValue | null;
        providerRef: string | null;
        expiresAt: Date | null;
        completedAt: Date | null;
        shopifyConnectionId: string | null;
    }>;
    sendDraftOrderPaymentLink(tenantId: string, agentId: string, payload: {
        email: string;
        variantId: string;
        quantity: number;
    }): Promise<DraftOrderPaymentLinkResult>;
    sendAggregatedDraftOrderPaymentLink(tenantId: string, agentId: string, payload: {
        email: string;
        lines: Array<{
            variantId: string;
            quantity: number;
        }>;
        existingDraftOrderId?: string | null;
        sendShopifyInvoice?: boolean;
    }): Promise<DraftOrderPaymentLinkResult>;
}
