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
        priority: number;
        branchProfileId: string | null;
        id: string;
        tenantId: string;
        storeId: string;
        language: string;
        createdAt: Date;
        updatedAt: Date;
        tags: string | null;
        question: string;
        answer: string;
        isActive: boolean;
    }>;
    findAll(tenantId: string, storeId?: string, branchProfileId?: string, isActive?: boolean): Promise<{
        priority: number;
        branchProfileId: string | null;
        id: string;
        tenantId: string;
        storeId: string;
        language: string;
        createdAt: Date;
        updatedAt: Date;
        tags: string | null;
        question: string;
        answer: string;
        isActive: boolean;
    }[]>;
    findOne(tenantId: string, id: string): Promise<{
        priority: number;
        branchProfileId: string | null;
        id: string;
        tenantId: string;
        storeId: string;
        language: string;
        createdAt: Date;
        updatedAt: Date;
        tags: string | null;
        question: string;
        answer: string;
        isActive: boolean;
    }>;
    update(tenantId: string, id: string, dto: Partial<{
        question: string;
        answer: string;
        language: string;
        tags: string;
        priority: number;
        isActive: boolean;
    }>): Promise<{
        priority: number;
        branchProfileId: string | null;
        id: string;
        tenantId: string;
        storeId: string;
        language: string;
        createdAt: Date;
        updatedAt: Date;
        tags: string | null;
        question: string;
        answer: string;
        isActive: boolean;
    }>;
    remove(tenantId: string, id: string): Promise<{
        priority: number;
        branchProfileId: string | null;
        id: string;
        tenantId: string;
        storeId: string;
        language: string;
        createdAt: Date;
        updatedAt: Date;
        tags: string | null;
        question: string;
        answer: string;
        isActive: boolean;
    }>;
    search(tenantId: string, storeId: string, query: string, branchProfileId?: string, limit?: number): Promise<{
        id: string;
        question: string;
        answer: string;
        branchProfileId: string | null;
    }[]>;
}
