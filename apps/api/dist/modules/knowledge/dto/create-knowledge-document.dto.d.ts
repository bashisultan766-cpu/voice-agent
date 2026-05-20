import { KnowledgeDocType, KnowledgeStatus } from '@prisma/client';
export declare class CreateKnowledgeDocumentDto {
    storeId: string;
    branchProfileId?: string;
    title: string;
    type: KnowledgeDocType;
    status?: KnowledgeStatus;
    language?: string;
    content: string;
    summary?: string;
    isVoiceOptimized?: boolean;
}
