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
        storeId: string;
        language: string;
        tags: string | null;
        question: string;
        answer: string;
        priority: number;
        isActive: boolean;
        branchProfileId: string | null;
    }>;
    findAll(tenantId: string, storeId?: string, branchProfileId?: string, isActive?: boolean): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        storeId: string;
        language: string;
        tags: string | null;
        question: string;
        answer: string;
        priority: number;
        isActive: boolean;
        branchProfileId: string | null;
    }[]>;
    findOne(tenantId: string, id: string): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        storeId: string;
        language: string;
        tags: string | null;
        question: string;
        answer: string;
        priority: number;
        isActive: boolean;
        branchProfileId: string | null;
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
        storeId: string;
        language: string;
        tags: string | null;
        question: string;
        answer: string;
        priority: number;
        isActive: boolean;
        branchProfileId: string | null;
    }>;
    remove(tenantId: string, id: string): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        storeId: string;
        language: string;
        tags: string | null;
        question: string;
        answer: string;
        priority: number;
        isActive: boolean;
        branchProfileId: string | null;
    }>;
    search(tenantId: string, storeId: string, query: string, branchProfileId?: string, limit?: number): Promise<{
        id: string;
        question: string;
        answer: string;
        branchProfileId: string | null;
    }[]>;
}
