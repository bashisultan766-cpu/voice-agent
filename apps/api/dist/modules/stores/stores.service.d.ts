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
        name: string;
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        slug: string;
        status: import("@prisma/client").$Enums.StoreStatus;
        city: string | null;
        address: string | null;
        phone: string | null;
        timezone: string | null;
    }>;
    findAll(tenantId: string): Promise<{
        email: string | null;
        name: string;
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        slug: string;
        status: import("@prisma/client").$Enums.StoreStatus;
        city: string | null;
        address: string | null;
        phone: string | null;
        timezone: string | null;
    }[]>;
    updateForTenant(tenantId: string, id: string, data: Record<string, unknown>): Promise<{
        email: string | null;
        name: string;
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        slug: string;
        status: import("@prisma/client").$Enums.StoreStatus;
        city: string | null;
        address: string | null;
        phone: string | null;
        timezone: string | null;
    }>;
}
