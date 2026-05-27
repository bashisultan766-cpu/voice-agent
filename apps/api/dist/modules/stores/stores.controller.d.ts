import { StoresService } from './stores.service';
import { createStoreBodySchema, patchStoreBodySchema } from './stores-validation';
import type { z } from 'zod';
export declare class StoresController {
    private readonly storesService;
    constructor(storesService: StoresService);
    create(tenantId: string, body: z.infer<typeof createStoreBodySchema>): Promise<{
        name: string;
        id: string;
        tenantId: string;
        slug: string;
        timezone: string | null;
        status: import("@prisma/client").$Enums.StoreStatus;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        city: string | null;
        address: string | null;
        phone: string | null;
        email: string | null;
    }>;
    findAll(tenantId: string): Promise<{
        name: string;
        id: string;
        tenantId: string;
        slug: string;
        timezone: string | null;
        status: import("@prisma/client").$Enums.StoreStatus;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        city: string | null;
        address: string | null;
        phone: string | null;
        email: string | null;
    }[]>;
    update(tenantId: string, id: string, body: z.infer<typeof patchStoreBodySchema>): Promise<{
        name: string;
        id: string;
        tenantId: string;
        slug: string;
        timezone: string | null;
        status: import("@prisma/client").$Enums.StoreStatus;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
        city: string | null;
        address: string | null;
        phone: string | null;
        email: string | null;
    }>;
}
