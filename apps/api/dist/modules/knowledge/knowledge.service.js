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
exports.KnowledgeService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../database/prisma.service");
const client_1 = require("@prisma/client");
let KnowledgeService = class KnowledgeService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async create(tenantId, dto) {
        return this.prisma.knowledgeDocument.create({
            data: {
                tenantId,
                storeId: dto.storeId,
                branchProfileId: dto.branchProfileId,
                title: dto.title,
                type: dto.type,
                status: dto.status ?? client_1.KnowledgeStatus.DRAFT,
                language: dto.language ?? 'en',
                content: dto.content,
                summary: dto.summary,
                isVoiceOptimized: dto.isVoiceOptimized ?? false,
            },
        });
    }
    async findAll(tenantId, storeId, type, status) {
        return this.prisma.knowledgeDocument.findMany({
            where: {
                tenantId,
                ...(storeId && { storeId }),
                ...(type && { type }),
                ...(status && { status }),
            },
            orderBy: { updatedAt: 'desc' },
        });
    }
    async findOne(tenantId, id) {
        const doc = await this.prisma.knowledgeDocument.findFirst({
            where: { id, tenantId },
        });
        if (!doc)
            throw new common_1.NotFoundException('Knowledge document not found');
        return doc;
    }
    async update(tenantId, id, dto) {
        await this.findOne(tenantId, id);
        return this.prisma.knowledgeDocument.update({
            where: { id },
            data: dto,
        });
    }
    async remove(tenantId, id) {
        await this.findOne(tenantId, id);
        return this.prisma.knowledgeDocument.delete({ where: { id } });
    }
    async getByType(tenantId, storeId, type, branchProfileId) {
        return this.prisma.knowledgeDocument.findMany({
            where: {
                tenantId,
                storeId,
                type,
                status: client_1.KnowledgeStatus.ACTIVE,
                ...(branchProfileId && { branchProfileId }),
            },
            orderBy: { updatedAt: 'desc' },
            take: 3,
        });
    }
};
exports.KnowledgeService = KnowledgeService;
exports.KnowledgeService = KnowledgeService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], KnowledgeService);
//# sourceMappingURL=knowledge.service.js.map