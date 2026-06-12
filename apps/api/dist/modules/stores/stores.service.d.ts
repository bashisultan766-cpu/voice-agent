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
        createdAt: Date;
        name: string;
        tenantId: string;
        updatedAt: Date;
        email: string | null;
        status: import("@prisma/client").$Enums.StoreStatus;
        phone: string | null;
        slug: string;
        timezone: string | null;
        deletedAt: Date | null;
        city: string | null;
        address: string | null;
    }>;
    findAll(tenantId: string): Promise<{
        id: string;
        createdAt: Date;
        name: string;
        tenantId: string;
        updatedAt: Date;
        email: string | null;
        status: import("@prisma/client").$Enums.StoreStatus;
        phone: string | null;
        slug: string;
        timezone: string | null;
        deletedAt: Date | null;
        city: string | null;
        address: string | null;
    }[]>;
    updateForTenant(tenantId: string, id: string, data: Record<string, unknown>): Promise<{
        id: string;
        createdAt: Date;
        name: string;
        tenantId: string;
        updatedAt: Date;
        email: string | null;
        status: import("@prisma/client").$Enums.StoreStatus;
        phone: string | null;
        slug: string;
        timezone: string | null;
        deletedAt: Date | null;
        city: string | null;
        address: string | null;
    }>;
}
