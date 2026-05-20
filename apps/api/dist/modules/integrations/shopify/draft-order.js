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
exports.ShopifyDraftOrderService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../database/prisma.service");
const client_1 = require("./client");
const shopify_errors_1 = require("./shopify-errors");
const shopify_ids_1 = require("./shopify-ids");
let ShopifyDraftOrderService = class ShopifyDraftOrderService {
    constructor(prisma, client) {
        this.prisma = prisma;
        this.client = client;
    }
    async createDraftOrderCheckout(tenantId, agentId, payload) {
        const customerEmail = payload.email.trim();
        if (!customerEmail) {
            throw new shopify_errors_1.ShopifyCheckoutValidationError('EMAIL_REQUIRED', 'Customer email is required before creating draft order invoice.');
        }
        const normalizedItems = payload.lines
            .map((item) => ({
            variantGid: (0, shopify_ids_1.toProductVariantGid)(item.variantGid),
            quantity: Math.max(1, item.quantity || 1),
            storefrontVariantId: item.storefrontVariantId,
            title: item.title,
            sku: item.sku,
        }))
            .filter((item) => item.variantGid.length > 0);
        if (normalizedItems.length === 0) {
            throw new shopify_errors_1.ShopifyCheckoutValidationError('NO_LINE_ITEMS', 'At least one valid variant is required to create draft order invoice.');
        }
        const { domain, token, shopifyConnectionId } = await this.client.getAgentShopifyConfig(tenantId, agentId);
        const mutation = `
      mutation DraftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id invoiceUrl }
          userErrors { field message }
        }
      }
    `;
        const data = await this.client.adminGraphql(domain, token, mutation, {
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
            throw new shopify_errors_1.ShopifyCheckoutValidationError('DRAFT_ORDER_USER_ERROR', msg);
        }
        const invoiceUrl = data.draftOrderCreate.draftOrder?.invoiceUrl;
        if (!invoiceUrl) {
            throw new shopify_errors_1.ShopifyCheckoutValidationError('DRAFT_ORDER_NO_INVOICE_URL', 'Draft order was created but Shopify did not return an invoice URL.');
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
                itemsJson: normalizedItems,
                providerRef: data.draftOrderCreate.draftOrder?.id ?? null,
                status: 'CREATED',
                metadata: (() => {
                    const base = payload.metadata &&
                        typeof payload.metadata === 'object' &&
                        !Array.isArray(payload.metadata)
                        ? { ...payload.metadata }
                        : {};
                    return {
                        ...base,
                        draftOrderId: data.draftOrderCreate.draftOrder?.id ?? null,
                        invoiceUrl,
                    };
                })(),
            },
        });
    }
};
exports.ShopifyDraftOrderService = ShopifyDraftOrderService;
exports.ShopifyDraftOrderService = ShopifyDraftOrderService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        client_1.ShopifyClientService])
], ShopifyDraftOrderService);
//# sourceMappingURL=draft-order.js.map