import { PrismaService } from '../../database/prisma.service';
export declare class FaqService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    create(tenantId: string, dto: {
        storeId: string;
        branchProfileId?: string;
        question: string;
        answer: string;
        language?: string;
        tags?: string;
        priority?: number;
        isActive?: boolean;
    }): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        priority: number;
        branchProfileId: string | null;
        storeId: string;
        language: string;
        isActive: boolean;
        tags: string | null;
        question: string;
        answer: string;
    }>;
    findAll(tenantId: string, storeId?: string, branchProfileId?: string, isActive?: boolean): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        priority: number;
        branchProfileId: string | null;
        storeId: string;
        language: string;
        isActive: boolean;
        tags: string | null;
        question: string;
        answer: string;
    }[]>;
    findOne(tenantId: string, id: string): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        priority: number;
        branchProfileId: string | null;
        storeId: string;
        language: string;
        isActive: boolean;
        tags: string | null;
        question: string;
        answer: string;
    }>;
    update(tenantId: string, id: string, dto: Partial<{
        question: string;
        answer: string;
        language: string;
        tags: string;
        priority: number;
        isActive: boolean;
    }>): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        priority: number;
        branchProfileId: string | null;
        storeId: string;
        language: string;
        isActive: boolean;
        tags: string | null;
        question: string;
        answer: string;
    }>;
    remove(tenantId: string, id: string): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        priority: number;
        branchProfileId: string | null;
        storeId: string;
        language: string;
        isActive: boolean;
        tags: string | null;
        question: string;
        answer: string;
    }>;
    search(tenantId: string, storeId: string, query: string, branchProfileId?: string, limit?: number): Promise<{
        id: string;
        question: string;
        answer: string;
        branchProfileId: string | null;
    }[]>;
}
