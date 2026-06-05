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
    async sendDraftOrderPaymentLink(tenantId, agentId, payload) {
        return this.sendAggregatedDraftOrderPaymentLink(tenantId, agentId, {
            email: payload.email,
            lines: [{ variantId: payload.variantId, quantity: payload.quantity }],
        });
    }
    async sendAggregatedDraftOrderPaymentLink(tenantId, agentId, payload) {
        const customerEmail = payload.email.trim().toLowerCase();
        if (!customerEmail) {
            throw new shopify_errors_1.ShopifyCheckoutValidationError('EMAIL_REQUIRED', 'Customer email is required before sending a payment link.');
        }
        const normalizedLines = payload.lines
            .map((line) => {
            const variantGid = (0, shopify_ids_1.toProductVariantGid)(line.variantId);
            const variantNumericId = (0, shopify_ids_1.extractTrailingNumericId)(variantGid);
            if (!variantGid.startsWith('gid://shopify/ProductVariant/') || !variantNumericId || variantNumericId === '0') {
                return null;
            }
            return {
                variantGid,
                quantity: Math.max(1, Math.min(99, Math.floor(line.quantity || 1))),
            };
        })
            .filter((line) => line != null);
        if (normalizedLines.length === 0) {
            throw new shopify_errors_1.ShopifyCheckoutValidationError('INVALID_VARIANT_ID', 'At least one valid Shopify product variant is required.');
        }
        const { domain, token, apiVersion, shopifyConnectionId } = await this.client.getAgentShopifyConfig(tenantId, agentId);
        const lineItemsInput = normalizedLines.map((line) => ({
            variantId: line.variantGid,
            quantity: line.quantity,
        }));
        const existingDraftOrderId = payload.existingDraftOrderId?.trim() || null;
        let draftOrderId = null;
        let invoiceUrlFromMutation = null;
        if (existingDraftOrderId) {
            const updateMutation = `
        mutation DraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
          draftOrderUpdate(id: $id, input: $input) {
            draftOrder { id invoiceUrl }
            userErrors { field message }
          }
        }
      `;
            const updateData = await this.client.adminGraphql(domain, token, updateMutation, {
                id: existingDraftOrderId,
                input: {
                    email: customerEmail,
                    lineItems: lineItemsInput,
                },
            }, apiVersion);
            const updateErrors = updateData.draftOrderUpdate.userErrors ?? [];
            if (updateErrors.length) {
                const msg = updateErrors.map((e) => e.message).filter(Boolean).join('; ') ||
                    'Draft order could not be updated.';
                throw new shopify_errors_1.ShopifyCheckoutValidationError('DRAFT_ORDER_USER_ERROR', msg);
            }
            draftOrderId = updateData.draftOrderUpdate.draftOrder?.id ?? existingDraftOrderId;
            invoiceUrlFromMutation = updateData.draftOrderUpdate.draftOrder?.invoiceUrl ?? null;
        }
        else {
            const createMutation = `
        mutation DraftOrderCreate($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder { id invoiceUrl }
            userErrors { field message }
          }
        }
      `;
            const createData = await this.client.adminGraphql(domain, token, createMutation, {
                input: {
                    email: customerEmail,
                    lineItems: lineItemsInput,
                },
            }, apiVersion);
            const createErrors = createData.draftOrderCreate.userErrors ?? [];
            if (createErrors.length) {
                const msg = createErrors.map((e) => e.message).filter(Boolean).join('; ') ||
                    'Draft order could not be created.';
                throw new shopify_errors_1.ShopifyCheckoutValidationError('DRAFT_ORDER_USER_ERROR', msg);
            }
            draftOrderId = createData.draftOrderCreate.draftOrder?.id ?? null;
            invoiceUrlFromMutation = createData.draftOrderCreate.draftOrder?.invoiceUrl ?? null;
        }
        if (!draftOrderId) {
            throw new shopify_errors_1.ShopifyCheckoutValidationError('DRAFT_ORDER_MISSING_ID', 'Draft order was created but Shopify did not return a draft order id.');
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
        let shopifyInvoiceError;
        let invoiceUrlFromSend = null;
        if (shouldSendShopifyInvoice) {
            try {
                const invoiceData = await this.client.adminGraphql(domain, token, invoiceSendMutation, {
                    id: draftOrderId,
                    email: { to: customerEmail },
                }, apiVersion);
                const invoiceErrors = invoiceData.draftOrderInvoiceSend.userErrors ?? [];
                if (invoiceErrors.length) {
                    shopifyInvoiceError =
                        invoiceErrors.map((e) => e.message).filter(Boolean).join('; ') ||
                            'Draft order invoice could not be sent.';
                }
                else {
                    shopifyInvoiceSent = true;
                    invoiceUrlFromSend = invoiceData.draftOrderInvoiceSend.draftOrder?.invoiceUrl ?? null;
                }
            }
            catch (err) {
                shopifyInvoiceError = err instanceof Error ? err.message : String(err);
            }
        }
        const invoiceUrl = invoiceUrlFromSend ?? invoiceUrlFromMutation;
        if (!invoiceUrl) {
            throw new shopify_errors_1.ShopifyCheckoutValidationError('DRAFT_ORDER_NO_INVOICE_URL', 'Draft order was created but Shopify did not return an invoice URL.');
        }
        return {
            draftOrderId,
            invoiceUrl,
            shopifyInvoiceSent,
            shopifyInvoiceError,
            shopifyConnectionId,
        };
    }
};
exports.ShopifyDraftOrderService = ShopifyDraftOrderService;
exports.ShopifyDraftOrderService = ShopifyDraftOrderService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        client_1.ShopifyClientService])
], ShopifyDraftOrderService);
//# sourceMappingURL=draft-order.js.map