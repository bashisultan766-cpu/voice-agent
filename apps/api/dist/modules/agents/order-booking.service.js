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
exports.OrderBookingService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../database/prisma.service");
let OrderBookingService = class OrderBookingService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async ensureDraft(callSessionId, tenantId, agentId) {
        return this.prisma.orderBookingDraft.upsert({
            where: { callSessionId },
            create: {
                callSessionId,
                tenantId,
                agentId,
            },
            update: {},
        });
    }
    async startBooking(callSessionId, tenantId, agentId, items) {
        const draft = await this.ensureDraft(callSessionId, tenantId, agentId);
        const normalized = items
            .filter((i) => i.productId?.trim())
            .map((i) => ({
            productId: i.productId.trim(),
            variantId: i.variantId?.trim() || undefined,
            title: i.title?.trim() || undefined,
            quantity: Math.max(1, Number(i.quantity) || 1),
        }));
        return this.prisma.orderBookingDraft.update({
            where: { id: draft.id },
            data: {
                itemsJson: normalized,
                status: client_1.OrderBookingStatus.DRAFT,
            },
        });
    }
    async setCustomerDetails(callSessionId, tenantId, agentId, customer) {
        const draft = await this.ensureDraft(callSessionId, tenantId, agentId);
        return this.prisma.orderBookingDraft.update({
            where: { id: draft.id },
            data: {
                customerJson: {
                    name: customer.name.trim(),
                    phone: customer.phone.trim(),
                    email: customer.email?.trim() || undefined,
                },
            },
        });
    }
    async setDeliveryDetails(callSessionId, tenantId, agentId, address) {
        const draft = await this.ensureDraft(callSessionId, tenantId, agentId);
        return this.prisma.orderBookingDraft.update({
            where: { id: draft.id },
            data: {
                deliveryAddressJson: {
                    addressLine1: address.addressLine1.trim(),
                    city: address.city.trim(),
                    postalCode: address.postalCode?.trim() || undefined,
                    country: address.country?.trim() || undefined,
                },
            },
        });
    }
    async confirmOrderSummary(callSessionId, tenantId, agentId, confirmed) {
        const draft = await this.ensureDraft(callSessionId, tenantId, agentId);
        return this.prisma.orderBookingDraft.update({
            where: { id: draft.id },
            data: confirmed
                ? {
                    status: client_1.OrderBookingStatus.READY_FOR_PAYMENT,
                    confirmedAt: new Date(),
                }
                : {
                    status: client_1.OrderBookingStatus.DRAFT,
                    confirmedAt: null,
                },
        });
    }
    async attachCheckoutLink(callSessionId, checkoutUrl, channel, destination) {
        return this.prisma.orderBookingDraft.update({
            where: { callSessionId },
            data: {
                status: client_1.OrderBookingStatus.CHECKOUT_CREATED,
                checkoutUrl,
                paymentChannel: channel,
                paymentDestination: destination,
            },
        });
    }
    async getDraft(callSessionId) {
        return this.prisma.orderBookingDraft.findUnique({
            where: { callSessionId },
        });
    }
};
exports.OrderBookingService = OrderBookingService;
exports.OrderBookingService = OrderBookingService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], OrderBookingService);
//# sourceMappingURL=order-booking.service.js.map