import { PrismaService } from '../../database/prisma.service';
export declare class StoresService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    create(data: {
        tenantId: string;
        name: string;
        slug: string;
    }): Promise<{
        email: string | null;
        id: string;
        tenantId: string;
        status: import("@prisma/client").$Enums.StoreStatus;
        createdAt: Date;
        updatedAt: Date;
        name: string;
        slug: string;
        timezone: string | null;
        deletedAt: Date | null;
        city: string | null;
        address: string | null;
        phone: string | null;
    }>;
    findAll(tenantId: string): Promise<{
        email: string | null;
        id: string;
        tenantId: string;
        status: import("@prisma/client").$Enums.StoreStatus;
        createdAt: Date;
        updatedAt: Date;
        name: string;
        slug: string;
        timezone: string | null;
        deletedAt: Date | null;
        city: string | null;
        address: string | null;
        phone: string | null;
    }[]>;
    updateForTenant(tenantId: string, id: string, data: Record<string, unknown>): Promise<{
        email: string | null;
        id: string;
        tenantId: string;
        status: import("@prisma/client").$Enums.StoreStatus;
        createdAt: Date;
        updatedAt: Date;
        name: string;
        slug: string;
        timezone: string | null;
        deletedAt: Date | null;
        city: string | null;
        address: string | null;
        phone: string | null;
    }>;
}
