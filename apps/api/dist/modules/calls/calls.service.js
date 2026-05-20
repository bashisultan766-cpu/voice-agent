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
exports.CallsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../database/prisma.service");
const client_1 = require("@prisma/client");
let CallsService = class CallsService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async createSession(input) {
        return this.prisma.callSession.create({
            data: {
                tenantId: input.tenantId,
                storeId: input.storeId ?? undefined,
                agentId: input.agentId,
                phoneNumberId: input.phoneNumberId,
                twilioCallSid: input.twilioCallSid,
                fromNumber: input.fromNumber,
                toNumber: input.toNumber,
                direction: input.direction ?? 'inbound',
                status: client_1.CallStatus.INITIATED,
                startedAt: new Date(),
            },
        });
    }
    async updateSessionStatus(callSessionId, data) {
        const { metadata, ...rest } = data;
        const updateData = {
            ...rest,
            ...(metadata !== undefined && { metadata: metadata }),
        };
        return this.prisma.callSession.update({
            where: { id: callSessionId },
            data: updateData,
        });
    }
    async updateSessionByTwilioCallSid(twilioCallSid, data) {
        return this.prisma.callSession.updateMany({
            where: { twilioCallSid },
            data,
        });
    }
    async findAllForTenant(tenantId) {
        return this.prisma.callSession.findMany({
            where: { tenantId },
            take: 50,
            orderBy: { createdAt: 'desc' },
        });
    }
    async findOneForTenant(tenantId, id) {
        return this.prisma.callSession.findFirstOrThrow({
            where: { id, tenantId },
            include: { transcripts: true, toolExecutions: true },
        });
    }
    async findOneById(id) {
        return this.prisma.callSession.findUniqueOrThrow({
            where: { id },
            include: { transcripts: true, toolExecutions: true },
        });
    }
    async findOneByTwilioCallSid(twilioCallSid) {
        return this.prisma.callSession.findFirst({
            where: { twilioCallSid },
        });
    }
    async mergeSessionMetadata(callSessionId, patch) {
        const existing = await this.prisma.callSession.findUnique({
            where: { id: callSessionId },
            select: { metadata: true },
        });
        const current = existing?.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
            ? existing.metadata
            : {};
        return this.prisma.callSession.update({
            where: { id: callSessionId },
            data: { metadata: { ...current, ...patch } },
        });
    }
};
exports.CallsService = CallsService;
exports.CallsService = CallsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], CallsService);
//# sourceMappingURL=calls.service.js.map