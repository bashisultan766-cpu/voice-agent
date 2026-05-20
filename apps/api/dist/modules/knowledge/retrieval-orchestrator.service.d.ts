import { PrismaService } from '../../database/prisma.service';
import { FaqService } from './faq.service';
import { BranchProfileService } from './branch-profile.service';
import { KnowledgeService } from './knowledge.service';
import { VectorStoreService } from './vector-store.service';
import type { RetrievalResult } from './retrieval.service';
export type QueryCategory = 'product' | 'inventory' | 'order' | 'policy' | 'branch_info' | 'timing_location' | 'promotion' | 'faq' | 'ambiguous';
export declare class RetrievalOrchestratorService {
    private readonly prisma;
    private readonly faqService;
    private readonly branchProfileService;
    private readonly knowledgeService;
    private readonly vectorStore;
    constructor(prisma: PrismaService, faqService: FaqService, branchProfileService: BranchProfileService, knowledgeService: KnowledgeService, vectorStore: VectorStoreService);
    classify(query: string): QueryCategory;
    retrieve(params: {
        tenantId: string;
        storeId: string;
        query: string;
        branchProfileId?: string;
        city?: string;
        topK?: number;
    }): Promise<RetrievalResult>;
}
