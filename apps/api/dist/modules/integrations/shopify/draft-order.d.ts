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
        status: import("@prisma/client").$Enums.CheckoutLinkStatus;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        agentId: string;
        metadata: Prisma.JsonValue | null;
        callSessionId: string | null;
        itemsJson: Prisma.JsonValue | null;
        checkoutUrl: string;
        completedAt: Date | null;
        mode: import("@prisma/client").$Enums.CheckoutMode;
        checkoutFingerprint: string | null;
        shopifyConnectionId: string | null;
        customerEmail: string | null;
        providerRef: string | null;
        expiresAt: Date | null;
        sentAt: Date | null;
    }>;
}
