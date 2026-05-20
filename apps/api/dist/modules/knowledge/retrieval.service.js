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
exports.RetrievalService = void 0;
const common_1 = require("@nestjs/common");
const faq_service_1 = require("./faq.service");
const branch_profile_service_1 = require("./branch-profile.service");
const knowledge_service_1 = require("./knowledge.service");
const client_1 = require("@prisma/client");
let RetrievalService = class RetrievalService {
    constructor(faqService, branchProfileService, knowledgeService) {
        this.faqService = faqService;
        this.branchProfileService = branchProfileService;
        this.knowledgeService = knowledgeService;
    }
    async searchFaqs(tenantId, storeId, query, branchProfileId, topK = 5) {
        const faqs = await this.faqService.search(tenantId, storeId, query, branchProfileId, topK);
        return {
            ok: true,
            source: 'faq',
            items: faqs.map((f) => ({
                id: f.id,
                title: f.question,
                snippet: f.answer,
                docType: 'faq',
            })),
            voiceSummary: faqs.length > 0
                ? faqs.slice(0, 2).map((f) => f.answer).join(' ')
                : undefined,
        };
    }
    async getBranchProfiles(tenantId, storeId, branchId, city) {
        const branches = await this.branchProfileService.getByStore(tenantId, storeId, branchId, city);
        return {
            ok: true,
            source: 'branch_profile',
            items: branches.map((b) => ({
                id: b.id,
                title: b.name,
                snippet: [b.address, b.phone, b.notes].filter(Boolean).join(' ') || 'No details',
                docType: 'branch_profile',
                branchName: b.name,
                city: b.city ?? undefined,
            })),
            voiceSummary: branches.length === 1
                ? this.formatBranchSummary(branches[0])
                : `${branches.length} branches found.`,
        };
    }
    async getStoreHours(tenantId, storeId, branchId) {
        const branches = await this.branchProfileService.getByStore(tenantId, storeId, branchId);
        const items = [];
        for (const b of branches) {
            const hours = b.openingHoursJson;
            const snippet = hours
                ? Object.entries(hours)
                    .map(([day, time]) => `${day}: ${time}`)
                    .join('; ')
                : 'Hours not set';
            items.push({
                id: b.id,
                title: b.name,
                snippet,
                docType: 'branch_profile',
                branchName: b.name,
                city: b.city ?? undefined,
            });
        }
        return {
            ok: true,
            source: 'branch_profile',
            items,
            voiceSummary: items.length === 1 ? items[0].snippet : `${items.length} branches. ${items[0]?.snippet ?? ''}`,
        };
    }
    async getPromotionDetails(tenantId, storeId, branchProfileId) {
        const docs = await this.knowledgeService.getByType(tenantId, storeId, client_1.KnowledgeDocType.PROMOTION, branchProfileId);
        const items = docs.map((d) => ({
            id: d.id,
            title: d.title,
            snippet: d.summary || d.content.slice(0, 500),
            docType: 'promotion',
        }));
        return {
            ok: true,
            source: 'knowledge_document',
            items,
            voiceSummary: (docs[0]?.summary || docs[0]?.content?.slice(0, 300)) ?? 'No current promotions.',
        };
    }
    async getPolicy(tenantId, storeId, type, branchProfileId) {
        const docs = await this.knowledgeService.getByType(tenantId, storeId, type, branchProfileId);
        const items = docs.map((d) => ({
            id: d.id,
            title: d.title,
            snippet: d.summary || d.content.slice(0, 500),
            docType: d.type,
        }));
        const voiceSummary = docs[0]?.summary || docs[0]?.content?.slice(0, 300);
        return {
            ok: true,
            source: 'knowledge_document',
            items,
            voiceSummary: voiceSummary ?? 'Policy not configured.',
        };
    }
    formatBranchSummary(b) {
        const parts = [b.name];
        if (b.city)
            parts.push(b.city);
        if (b.address)
            parts.push(b.address);
        if (b.phone)
            parts.push(`Phone: ${b.phone}`);
        return parts.join(', ');
    }
};
exports.RetrievalService = RetrievalService;
exports.RetrievalService = RetrievalService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [faq_service_1.FaqService,
        branch_profile_service_1.BranchProfileService,
        knowledge_service_1.KnowledgeService])
], RetrievalService);
//# sourceMappingURL=retrieval.service.js.map