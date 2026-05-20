import { FaqService } from './faq.service';
import { BranchProfileService } from './branch-profile.service';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeDocType } from '@prisma/client';
export interface RetrievalItem {
    id: string;
    title?: string;
    snippet: string;
    score?: number;
    docType?: string;
    branchName?: string;
    city?: string;
}
export interface RetrievalResult {
    ok: boolean;
    source: 'faq' | 'branch_profile' | 'knowledge_document' | 'vector_store' | 'hybrid';
    items: RetrievalItem[];
    voiceSummary?: string;
}
export declare class RetrievalService {
    private readonly faqService;
    private readonly branchProfileService;
    private readonly knowledgeService;
    constructor(faqService: FaqService, branchProfileService: BranchProfileService, knowledgeService: KnowledgeService);
    searchFaqs(tenantId: string, storeId: string, query: string, branchProfileId?: string, topK?: number): Promise<RetrievalResult>;
    getBranchProfiles(tenantId: string, storeId: string, branchId?: string, city?: string): Promise<RetrievalResult>;
    getStoreHours(tenantId: string, storeId: string, branchId?: string): Promise<RetrievalResult>;
    getPromotionDetails(tenantId: string, storeId: string, branchProfileId?: string): Promise<RetrievalResult>;
    getPolicy(tenantId: string, storeId: string, type: KnowledgeDocType, branchProfileId?: string): Promise<RetrievalResult>;
    private formatBranchSummary;
}
