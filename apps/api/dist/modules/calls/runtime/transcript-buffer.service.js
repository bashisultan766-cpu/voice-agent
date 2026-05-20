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
exports.TranscriptBufferService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../../database/prisma.service");
let TranscriptBufferService = class TranscriptBufferService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getConversationHistory(callSessionId, maxMessages = 24) {
        const rows = await this.prisma.callTranscript.findMany({
            where: { callSessionId, role: { in: ['user', 'agent'] } },
            orderBy: { sequenceNumber: 'desc' },
            take: maxMessages,
            select: { role: true, content: true },
        });
        const chronological = rows.reverse();
        return chronological.map((r) => ({
            role: r.role === 'user' ? 'user' : 'assistant',
            content: r.content,
        }));
    }
    async append(callSessionId, role, content, sequenceNumber, timestampMs) {
        await this.prisma.callTranscript.create({
            data: {
                callSessionId,
                role,
                content,
                sequenceNumber,
                timestampMs: timestampMs ?? undefined,
            },
        });
    }
    async getNextSequence(callSessionId) {
        const last = await this.prisma.callTranscript.findFirst({
            where: { callSessionId },
            orderBy: { sequenceNumber: 'desc' },
            select: { sequenceNumber: true },
        });
        return (last?.sequenceNumber ?? 0) + 1;
    }
};
exports.TranscriptBufferService = TranscriptBufferService;
exports.TranscriptBufferService = TranscriptBufferService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], TranscriptBufferService);
//# sourceMappingURL=transcript-buffer.service.js.map