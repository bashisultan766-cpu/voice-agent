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
exports.QaReviewService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../database/prisma.service");
const prisma_types_1 = require("../../database/prisma.types");
let QaReviewService = class QaReviewService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async listCallsForQa(tenantId, options) {
        const limit = options?.limit ?? 50;
        const sessions = await this.prisma.callSession.findMany({
            where: {
                tenantId,
                status: { in: prisma_types_1.TERMINAL_CALL_STATUSES },
                ...(options?.hasOutcome !== undefined && {
                    callOutcome: options.hasOutcome ? { isNot: null } : { is: null },
                }),
            },
            orderBy: { endedAt: 'desc' },
            take: limit,
            include: {
                callOutcome: true,
                agent: { select: { id: true, name: true } },
                store: { select: { id: true, name: true } },
                _count: { select: { toolExecutions: true } },
            },
        });
        return sessions;
    }
    async getQaDetail(callSessionId, tenantId) {
        const session = await this.prisma.callSession.findFirst({
            where: { id: callSessionId, tenantId },
            include: {
                callOutcome: true,
                callEvents: { orderBy: { timestamp: 'asc' } },
                transcripts: { orderBy: { sequenceNumber: 'asc' } },
                toolExecutions: { orderBy: { createdAt: 'asc' } },
                agent: { select: { id: true, name: true, baseSystemPrompt: true } },
                store: { select: { id: true, name: true } },
            },
        });
        if (!session)
            throw new common_1.NotFoundException('Call not found');
        return session;
    }
    async submitReview(tenantId, callSessionId, data) {
        const session = await this.prisma.callSession.findFirst({
            where: { id: callSessionId, tenantId },
            select: { id: true, agentId: true },
        });
        if (!session)
            throw new common_1.NotFoundException('Call not found');
        const review = await this.prisma.agentQualityReview.create({
            data: {
                tenantId,
                agentId: session.agentId,
                callSessionId: session.id,
                reviewerUserId: data.reviewerUserId,
                accuracyScore: data.accuracyScore,
                toneScore: data.toneScore,
                policyComplianceScore: data.policyComplianceScore,
                brevityScore: data.brevityScore,
                notes: data.notes,
                needsPromptUpdate: data.needsPromptUpdate ?? false,
                needsFaqUpdate: data.needsFaqUpdate ?? false,
            },
        });
        const scores = [data.accuracyScore, data.toneScore, data.policyComplianceScore, data.brevityScore].filter((s) => typeof s === 'number');
        const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
        if (avgScore > 0) {
            await this.prisma.callOutcome.updateMany({
                where: { callSessionId, tenantId },
                data: { qaScore: Math.round(avgScore * 100) / 100 },
            });
        }
        return review;
    }
};
exports.QaReviewService = QaReviewService;
exports.QaReviewService = QaReviewService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], QaReviewService);
//# sourceMappingURL=qa-review.service.js.map