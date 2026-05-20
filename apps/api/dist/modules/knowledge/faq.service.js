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
exports.FaqService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../database/prisma.service");
let FaqService = class FaqService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async create(tenantId, dto) {
        return this.prisma.storeFAQ.create({
            data: {
                tenantId,
                storeId: dto.storeId,
                branchProfileId: dto.branchProfileId,
                question: dto.question,
                answer: dto.answer,
                language: dto.language ?? 'en',
                tags: dto.tags,
                priority: dto.priority ?? 0,
                isActive: dto.isActive ?? true,
            },
        });
    }
    async findAll(tenantId, storeId, branchProfileId, isActive) {
        return this.prisma.storeFAQ.findMany({
            where: {
                tenantId,
                ...(storeId && { storeId }),
                ...(branchProfileId && { branchProfileId }),
                ...(isActive !== undefined && { isActive }),
            },
            orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        });
    }
    async findOne(tenantId, id) {
        const faq = await this.prisma.storeFAQ.findFirst({
            where: { id, tenantId },
        });
        if (!faq)
            throw new common_1.NotFoundException('FAQ not found');
        return faq;
    }
    async update(tenantId, id, dto) {
        await this.findOne(tenantId, id);
        return this.prisma.storeFAQ.update({
            where: { id },
            data: dto,
        });
    }
    async remove(tenantId, id) {
        await this.findOne(tenantId, id);
        return this.prisma.storeFAQ.delete({ where: { id } });
    }
    async search(tenantId, storeId, query, branchProfileId, limit = 5) {
        const q = query.toLowerCase().trim();
        const faqs = await this.prisma.storeFAQ.findMany({
            where: {
                tenantId,
                storeId,
                isActive: true,
                ...(branchProfileId && { branchProfileId }),
                OR: [
                    { question: { contains: q, mode: 'insensitive' } },
                    { answer: { contains: q, mode: 'insensitive' } },
                    { tags: { contains: q, mode: 'insensitive' } },
                ],
            },
            take: limit,
            orderBy: { priority: 'desc' },
        });
        return faqs.map((f) => ({ id: f.id, question: f.question, answer: f.answer, branchProfileId: f.branchProfileId }));
    }
};
exports.FaqService = FaqService;
exports.FaqService = FaqService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], FaqService);
//# sourceMappingURL=faq.service.js.map