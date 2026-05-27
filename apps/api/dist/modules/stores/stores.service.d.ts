import { PrismaService } from '../../database/prisma.service';
export declare class StoresService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    create(data: {
        tenantId: string;
        name: string;
        slug: string;
    }): Promise<{
        id: string;
        tenantId: string;
        name: string;
        slug: string;
        city: string | null;
        address: string | null;
        phone: string | null;
        email: string | null;
        timezone: string | null;
        status: import("@prisma/client").$Enums.StoreStatus;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
    }>;
    findAll(tenantId: string): Promise<{
        id: string;
        tenantId: string;
        name: string;
        slug: string;
        city: string | null;
        address: string | null;
        phone: string | null;
        email: string | null;
        timezone: string | null;
        status: import("@prisma/client").$Enums.StoreStatus;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
    }[]>;
    updateForTenant(tenantId: string, id: string, data: Record<string, unknown>): Promise<{
        id: string;
        tenantId: string;
        name: string;
        slug: string;
        city: string | null;
        address: string | null;
        phone: string | null;
        email: string | null;
        timezone: string | null;
        status: import("@prisma/client").$Enums.StoreStatus;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
    }>;
}
