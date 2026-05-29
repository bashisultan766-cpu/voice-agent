import { PrismaService } from '../../database/prisma.service';
export declare class TenantsService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    create(data: {
        name: string;
        slug: string;
    }): Promise<{
        name: string;
        id: string;
        slug: string;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
    }>;
    findOne(id: string): Promise<{
        name: string;
        id: string;
        slug: string;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
    }>;
}
