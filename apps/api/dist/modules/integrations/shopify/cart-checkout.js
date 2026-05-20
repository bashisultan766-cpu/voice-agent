"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShopifyCartCheckoutService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../database/prisma.service");
const client_1 = require("./client");
const shopify_errors_1 = require("./shopify-errors");
let ShopifyCartCheckoutService = class ShopifyCartCheckoutService {
    constructor(prisma, client) {
        this.prisma = prisma;
        this.client = client;
    }
    async createStorefrontCartCheckout(tenantId, agentId, payload) {
        const customerEmail = payload.email.trim();
        if (!customerEmail) {
            throw new shopify_errors_1.ShopifyCheckoutValidationError('EMAIL_REQUIRED', 'Customer email is required before creating a checkout URL.');
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
            throw new shopify_errors_1.ShopifyCheckoutValidationError('NO_LINE_ITEMS', 'At least one valid variant is required to create checkout.');
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
                itemsJson: normalizedItems,
                status: 'CREATED',
                metadata: payload.metadata,
            },
        });
        return link;
    }
};
exports.ShopifyCartCheckoutService = ShopifyCartCheckoutService;
exports.ShopifyCartCheckoutService = ShopifyCartCheckoutService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        client_1.ShopifyClientService])
], ShopifyCartCheckoutService);
//# sourceMappingURL=cart-checkout.js.map