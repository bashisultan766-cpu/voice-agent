import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ShopifyClientService } from './client';
export type StorefrontResolvedLine = {
    variantGid: string;
    storefrontVariantId: string;
    quantity: number;
    title?: string;
    sku?: string | null;
};
export declare class ShopifyCartCheckoutService {
    private readonly prisma;
    private readonly client;
    constructor(prisma: PrismaService, client: ShopifyClientService);
    createStorefrontCartCheckout(tenantId: string, agentId: string, payload: {
        callSessionId?: string;
        email: string;
        lines: StorefrontResolvedLine[];
        checkoutFingerprint: string;
        metadata: Prisma.InputJsonValue;
    }): Promise<{
        id: string;
        tenantId: string;
        status: import("@prisma/client").$Enums.CheckoutLinkStatus;
        createdAt: Date;
        updatedAt: Date;
        agentId: string;
        metadata: Prisma.JsonValue | null;
        mode: import("@prisma/client").$Enums.CheckoutMode;
        callSessionId: string | null;
        checkoutFingerprint: string | null;
        shopifyConnectionId: string | null;
        checkoutUrl: string;
        customerEmail: string | null;
        itemsJson: Prisma.JsonValue | null;
        providerRef: string | null;
        expiresAt: Date | null;
        sentAt: Date | null;
        completedAt: Date | null;
    }>;
}
