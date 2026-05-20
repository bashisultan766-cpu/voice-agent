import { PrismaService } from '../../database/prisma.service';
import { VectorStoreService } from './vector-store.service';
export declare class KnowledgeIngestionService {
    private readonly prisma;
    private readonly vectorStore;
    constructor(prisma: PrismaService, vectorStore: VectorStoreService);
    syncDocumentToVectorStore(tenantId: string, documentId: string): Promise<{
        ok: boolean;
        vectorStoreId?: string;
        vectorFileId?: string;
        error?: string;
    }>;
}
