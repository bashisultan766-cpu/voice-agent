import { PrismaService } from '../../../database/prisma.service';
import { ShopifyCartCheckoutService } from './cart-checkout';
import { ShopifyDraftOrderService } from './draft-order';
import { ShopifyClientService } from './client';
import { ShopifyProductSyncService } from './product-sync';
import { ShopifyProductSyncQueueService } from './product-sync.queue';
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
export declare class ShopifyCheckoutService {
    private readonly prisma;
    private readonly shopifyClient;
    private readonly cartCheckout;
    private readonly draftOrderCheckout;
    private readonly productSync;
    private readonly syncQueue;
    private readonly logger;
    constructor(prisma: PrismaService, shopifyClient: ShopifyClientService, cartCheckout: ShopifyCartCheckoutService, draftOrderCheckout: ShopifyDraftOrderService, productSync: ShopifyProductSyncService, syncQueue: ShopifyProductSyncQueueService);
    createCheckoutLink(tenantId: string, agentId: string, input: {
        items: CheckoutItem[];
        customer?: CheckoutCustomer;
        deliveryAddress?: DeliveryAddress;
        callSessionId?: string;
        mode?: 'STOREFRONT_CART' | 'DRAFT_ORDER_INVOICE';
        note?: string;
        forceNewCheckout?: boolean;
    }): Promise<CheckoutLinkCreateResult>;
    private buildFingerprint;
    private findReusableCheckoutLink;
    private resolveLineItem;
    private repairVariantCache;
    private enqueueCatalogHeal;
    private lookupVariantInCache;
    private toResolvedLine;
}
export {};
