import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
export interface VectorSearchResult {
    id: string;
    text: string;
    score?: number;
    metadata?: Record<string, unknown>;
}
export declare class VectorStoreService {
    private readonly prisma;
    private readonly config?;
    private client;
    private enabled;
    constructor(prisma: PrismaService, config?: ConfigService | undefined);
    isEnabled(): boolean;
    private get vectorStores();
    getOrCreateVectorStoreForStore(tenantId: string, storeId: string): Promise<string | null>;
    uploadAndAttach(vectorStoreId: string, fileBuffer: Buffer, fileName: string, metadata?: Record<string, string>): Promise<{
        fileId: string;
        vectorFileId: string;
    } | null>;
    waitUntilProcessed(vectorStoreId: string, vectorFileId: string): Promise<'completed' | 'failed'>;
    search(vectorStoreId: string, query: string, options?: {
        topK?: number;
        metadataFilter?: Record<string, string>;
    }): Promise<VectorSearchResult[]>;
    removeFile(vectorStoreId: string, vectorFileId: string): Promise<boolean>;
}
