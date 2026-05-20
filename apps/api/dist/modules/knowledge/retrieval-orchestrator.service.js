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
exports.RetrievalOrchestratorService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../database/prisma.service");
const faq_service_1 = require("./faq.service");
const branch_profile_service_1 = require("./branch-profile.service");
const knowledge_service_1 = require("./knowledge.service");
const vector_store_service_1 = require("./vector-store.service");
const client_1 = require("@prisma/client");
const POLICY_KEYWORDS = ['policy', 'return', 'refund', 'exchange', 'shipping', 'delivery', 'cod', 'payment', 'warranty', 'condition'];
const BRANCH_KEYWORDS = ['branch', 'location', 'store', 'address', 'city', 'phone', 'where'];
const TIMING_KEYWORDS = ['timing', 'hours', 'open', 'close', 'baje', 'time', 'sunday', 'monday'];
const FAQ_KEYWORDS = ['faq', 'question', 'how', 'what', 'can i', 'do you', 'kya', 'kaise', 'kahan'];
const PROMO_KEYWORDS = ['promotion', 'offer', 'discount', 'sale', 'deal', 'campaign'];
let RetrievalOrchestratorService = class RetrievalOrchestratorService {
    constructor(prisma, faqService, branchProfileService, knowledgeService, vectorStore) {
        this.prisma = prisma;
        this.faqService = faqService;
        this.branchProfileService = branchProfileService;
        this.knowledgeService = knowledgeService;
        this.vectorStore = vectorStore;
    }
    classify(query) {
        const q = query.toLowerCase().trim();
        if (/\b(order|tracking|status|number|email|phone)\b/i.test(q) && /#?\d{4,}/.test(q))
            return 'order';
        if (/\b(book|product|available|stock|inventory|kitab|copy)\b/i.test(q))
            return 'product';
        if (POLICY_KEYWORDS.some((k) => q.includes(k)))
            return 'policy';
        if (TIMING_KEYWORDS.some((k) => q.includes(k)) || /(\d{1,2}:\d{2}|baje)/.test(q))
            return 'timing_location';
        if (BRANCH_KEYWORDS.some((k) => q.includes(k)))
            return 'branch_info';
        if (PROMO_KEYWORDS.some((k) => q.includes(k)))
            return 'promotion';
        if (FAQ_KEYWORDS.some((k) => q.includes(k)) || q.length < 80)
            return 'faq';
        return 'ambiguous';
    }
    async retrieve(params) {
        const { tenantId, storeId, query, branchProfileId, city, topK = 5 } = params;
        const category = this.classify(query);
        switch (category) {
            case 'timing_location': {
                const branches = await this.branchProfileService.getByStore(tenantId, storeId, branchProfileId, city);
                const items = branches.map((b) => {
                    const hours = b.openingHoursJson;
                    const snippet = hours ? Object.entries(hours).map(([d, t]) => `${d}: ${t}`).join('; ') : 'Hours not set';
                    return { id: b.id, title: b.name, snippet, docType: 'branch_profile', branchName: b.name, city: b.city ?? undefined };
                });
                const voiceSummary = items.length === 1 ? items[0].snippet : items.length ? `${items.length} branches. ${items[0]?.snippet ?? ''}` : 'No hours set.';
                return { ok: true, source: 'branch_profile', items, voiceSummary };
            }
            case 'branch_info': {
                const branches = await this.branchProfileService.getByStore(tenantId, storeId, branchProfileId, city);
                const items = branches.map((b) => ({
                    id: b.id,
                    title: b.name,
                    snippet: [b.address, b.phone, b.notes].filter(Boolean).join(' ') || 'No details',
                    docType: 'branch_profile',
                    branchName: b.name,
                    city: b.city ?? undefined,
                }));
                const voiceSummary = branches.length === 1
                    ? [branches[0].name, branches[0].city, branches[0].address, branches[0].phone].filter(Boolean).join(', ')
                    : `${branches.length} branches found.`;
                return { ok: true, source: 'branch_profile', items, voiceSummary };
            }
            case 'faq': {
                const faqs = await this.faqService.search(tenantId, storeId, query, branchProfileId, topK);
                const items = faqs.map((f) => ({ id: f.id, title: f.question, snippet: f.answer, docType: 'faq' }));
                const voiceSummary = items.length > 0 ? items.slice(0, 2).map((i) => i.snippet).join(' ') : undefined;
                return { ok: true, source: 'faq', items, voiceSummary };
            }
            case 'policy': {
                const hasVector = this.vectorStore.isEnabled();
                const docWithVector = await this.prisma.knowledgeDocument.findFirst({
                    where: { tenantId, storeId, vectorStoreId: { not: null }, status: 'ACTIVE' },
                    select: { vectorStoreId: true },
                });
                if (hasVector && docWithVector?.vectorStoreId) {
                    const vectorResults = await this.vectorStore.search(docWithVector.vectorStoreId, query, { topK });
                    if (vectorResults.length > 0) {
                        const items = vectorResults.map((r, i) => ({ id: r.id || `v-${i}`, title: undefined, snippet: r.text, score: r.score }));
                        const voiceSummary = items[0]?.snippet?.slice(0, 400) ?? 'Policy not configured.';
                        return { ok: true, source: 'vector_store', items, voiceSummary };
                    }
                }
                const docs = await this.knowledgeService.getByType(tenantId, storeId, client_1.KnowledgeDocType.RETURN_POLICY, branchProfileId);
                const shipDocs = await this.knowledgeService.getByType(tenantId, storeId, client_1.KnowledgeDocType.SHIPPING_POLICY, branchProfileId);
                const all = [...docs, ...shipDocs];
                const items = all.map((d) => ({ id: d.id, title: d.title, snippet: d.summary || d.content.slice(0, 500), docType: d.type }));
                const voiceSummary = (all[0]?.summary || all[0]?.content?.slice(0, 300)) ?? 'Policy not configured.';
                return { ok: true, source: 'knowledge_document', items, voiceSummary };
            }
            case 'promotion': {
                const docs = await this.knowledgeService.getByType(tenantId, storeId, client_1.KnowledgeDocType.PROMOTION, branchProfileId);
                const items = docs.map((d) => ({ id: d.id, title: d.title, snippet: d.summary || d.content.slice(0, 400), docType: 'promotion' }));
                return { ok: true, source: 'knowledge_document', items, voiceSummary: items[0]?.snippet };
            }
            default: {
                const faqs = await this.faqService.search(tenantId, storeId, query, branchProfileId, topK);
                const items = faqs.map((f) => ({ id: f.id, title: f.question, snippet: f.answer, docType: 'faq' }));
                const voiceSummary = items.length > 0 ? items[0].snippet : undefined;
                return { ok: true, source: items.length ? 'faq' : 'knowledge_document', items, voiceSummary };
            }
        }
    }
};
exports.RetrievalOrchestratorService = RetrievalOrchestratorService;
exports.RetrievalOrchestratorService = RetrievalOrchestratorService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        faq_service_1.FaqService,
        branch_profile_service_1.BranchProfileService,
        knowledge_service_1.KnowledgeService,
        vector_store_service_1.VectorStoreService])
], RetrievalOrchestratorService);
//# sourceMappingURL=retrieval-orchestrator.service.js.map