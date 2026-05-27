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
        email: string | null;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        name: string;
        slug: string;
        status: import("@prisma/client").$Enums.StoreStatus;
        city: string | null;
        address: string | null;
        phone: string | null;
        timezone: string | null;
    }>;
    findAll(tenantId: string): Promise<{
        id: string;
        tenantId: string;
        email: string | null;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        name: string;
        slug: string;
        status: import("@prisma/client").$Enums.StoreStatus;
        city: string | null;
        address: string | null;
        phone: string | null;
        timezone: string | null;
    }[]>;
    updateForTenant(tenantId: string, id: string, data: Record<string, unknown>): Promise<{
        id: string;
        tenantId: string;
        email: string | null;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        name: string;
        slug: string;
        status: import("@prisma/client").$Enums.StoreStatus;
        city: string | null;
        address: string | null;
        phone: string | null;
        timezone: string | null;
    }>;
}
