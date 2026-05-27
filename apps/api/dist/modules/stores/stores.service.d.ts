import { PrismaService } from '../../database/prisma.service';
export declare class StoresService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    create(data: {
        tenantId: string;
        name: string;
        slug: string;
    }): Promise<{
        name: string;
        status: import("@prisma/client").$Enums.StoreStatus;
        id: string;
        slug: string;
        timezone: string | null;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        tenantId: string;
        city: string | null;
        address: string | null;
        phone: string | null;
        email: string | null;
    }>;
    findAll(tenantId: string): Promise<{
        name: string;
        status: import("@prisma/client").$Enums.StoreStatus;
        id: string;
        slug: string;
        timezone: string | null;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        tenantId: string;
        city: string | null;
        address: string | null;
        phone: string | null;
        email: string | null;
    }[]>;
    updateForTenant(tenantId: string, id: string, data: Record<string, unknown>): Promise<{
        name: string;
        status: import("@prisma/client").$Enums.StoreStatus;
        id: string;
        slug: string;
        timezone: string | null;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        tenantId: string;
        city: string | null;
        address: string | null;
        phone: string | null;
        email: string | null;
    }>;
}
