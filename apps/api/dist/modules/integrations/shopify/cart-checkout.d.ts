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
        status: import("@prisma/client").$Enums.CheckoutLinkStatus;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        agentId: string;
        metadata: Prisma.JsonValue | null;
        callSessionId: string | null;
        sentAt: Date | null;
        checkoutUrl: string;
        checkoutFingerprint: string | null;
        shopifyConnectionId: string | null;
        mode: import("@prisma/client").$Enums.CheckoutMode;
        customerEmail: string | null;
        itemsJson: Prisma.JsonValue | null;
        providerRef: string | null;
        expiresAt: Date | null;
        completedAt: Date | null;
    }>;
}
