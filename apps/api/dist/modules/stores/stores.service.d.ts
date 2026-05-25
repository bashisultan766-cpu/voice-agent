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
        phone: string | null;
        name: string;
        city: string | null;
        id: string;
        tenantId: string;
        slug: string;
        timezone: string | null;
        status: import("@prisma/client").$Enums.StoreStatus;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        address: string | null;
    }>;
    findAll(tenantId: string): Promise<{
        email: string | null;
        phone: string | null;
        name: string;
        city: string | null;
        id: string;
        tenantId: string;
        slug: string;
        timezone: string | null;
        status: import("@prisma/client").$Enums.StoreStatus;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        address: string | null;
    }[]>;
    updateForTenant(tenantId: string, id: string, data: Record<string, unknown>): Promise<{
        email: string | null;
        phone: string | null;
        name: string;
        city: string | null;
        id: string;
        tenantId: string;
        slug: string;
        timezone: string | null;
        status: import("@prisma/client").$Enums.StoreStatus;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        address: string | null;
    }>;
}
