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
    constructor(prisma: PrismaService, client: ShopifyClientService);
    createDraftOrderCheckout(tenantId: string, agentId: string, payload: {
        callSessionId?: string;
        email: string;
        lines: DraftResolvedLine[];
        note?: string;
        checkoutFingerprint: string;
        metadata: Prisma.InputJsonValue;
    }): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.CheckoutLinkStatus;
        callSessionId: string | null;
        checkoutUrl: string;
        customerEmail: string | null;
        mode: import("@prisma/client").$Enums.CheckoutMode;
        agentId: string;
        metadata: Prisma.JsonValue | null;
        sentAt: Date | null;
        checkoutFingerprint: string | null;
        shopifyConnectionId: string | null;
        itemsJson: Prisma.JsonValue | null;
        providerRef: string | null;
        expiresAt: Date | null;
        completedAt: Date | null;
    }>;
    sendDraftOrderPaymentLink(tenantId: string, agentId: string, payload: {
        email: string;
        variantId: string;
        quantity: number;
    }): Promise<DraftOrderPaymentLinkResult>;
}
