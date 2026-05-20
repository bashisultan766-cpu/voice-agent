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
exports.CallOutcomeService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../database/prisma.service");
const client_1 = require("@prisma/client");
let CallOutcomeService = class CallOutcomeService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async deriveAndUpsert(callSessionId) {
        const session = await this.prisma.callSession.findUnique({
            where: { id: callSessionId },
            include: {
                toolExecutions: true,
            },
        });
        if (!session)
            return;
        const toolsUsed = session.toolExecutions.length;
        const toolFailures = session.toolExecutions.filter((t) => t.status === 'FAILED').length;
        const escalated = session.escalated ?? false;
        const metadata = session.metadata ?? {};
        const callbackRequested = Boolean(metadata.callbackRequested);
        let resolutionStatus;
        if (session.status === 'ABANDONED' || session.endedReason === 'abandoned') {
            resolutionStatus = client_1.CallResolutionStatus.ABANDONED;
        }
        else if (escalated || callbackRequested) {
            resolutionStatus = client_1.CallResolutionStatus.ESCALATED;
        }
        else if (toolFailures > 2 || (toolFailures > 0 && toolsUsed <= 1)) {
            resolutionStatus = client_1.CallResolutionStatus.UNRESOLVED;
        }
        else if (toolFailures > 0 || callbackRequested) {
            resolutionStatus = client_1.CallResolutionStatus.PARTIALLY_RESOLVED;
        }
        else {
            resolutionStatus = client_1.CallResolutionStatus.RESOLVED;
        }
        await this.prisma.callOutcome.upsert({
            where: { callSessionId },
            create: {
                tenantId: session.tenantId,
                callSessionId: session.id,
                resolutionStatus,
                toolsUsedCount: toolsUsed,
                toolFailuresCount: toolFailures,
                escalated,
                callbackRequested,
                summary: session.summary ?? undefined,
            },
            update: {
                resolutionStatus,
                toolsUsedCount: toolsUsed,
                toolFailuresCount: toolFailures,
                escalated,
                callbackRequested,
                summary: session.summary ?? undefined,
            },
        });
    }
    async getByCallSession(callSessionId) {
        return this.prisma.callOutcome.findUnique({
            where: { callSessionId },
        });
    }
    async update(tenantId, callSessionId, data) {
        await this.prisma.callOutcome.updateMany({
            where: { callSessionId, tenantId },
            data,
        });
        return this.getByCallSession(callSessionId);
    }
};
exports.CallOutcomeService = CallOutcomeService;
exports.CallOutcomeService = CallOutcomeService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], CallOutcomeService);
//# sourceMappingURL=call-outcome.service.js.map