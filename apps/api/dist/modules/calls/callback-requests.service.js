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
exports.CallbackRequestsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../database/prisma.service");
let CallbackRequestsService = class CallbackRequestsService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async create(input) {
        return this.prisma.callbackRequest.create({
            data: {
                tenantId: input.tenantId,
                agentId: input.agentId,
                callSessionId: input.callSessionId ?? undefined,
                phone: input.phone.trim(),
                reason: input.reason.trim(),
                priority: input.priority ?? 'normal',
                notes: input.notes?.trim() || null,
            },
        });
    }
    async listForTenant(tenantId, options = {}) {
        return this.prisma.callbackRequest.findMany({
            where: {
                tenantId,
                ...(options.status ? { status: options.status } : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: Math.min(Math.max(options.limit ?? 50, 1), 200),
        });
    }
    async updateStatus(tenantId, id, status) {
        await this.prisma.callbackRequest.updateMany({
            where: { id, tenantId },
            data: { status },
        });
        return this.prisma.callbackRequest.findFirst({
            where: { id, tenantId },
        });
    }
    async markRequestedOnSession(callSessionId) {
        const session = await this.prisma.callSession.findUnique({
            where: { id: callSessionId },
            select: { metadata: true },
        });
        if (!session)
            return;
        const metadata = (session.metadata ?? {});
        metadata.callbackRequested = true;
        await this.prisma.callSession.update({
            where: { id: callSessionId },
            data: { metadata: metadata },
        });
    }
};
exports.CallbackRequestsService = CallbackRequestsService;
exports.CallbackRequestsService = CallbackRequestsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], CallbackRequestsService);
//# sourceMappingURL=callback-requests.service.js.map