import { StoresService } from './stores.service';
import { createStoreBodySchema, patchStoreBodySchema } from './stores-validation';
import type { z } from 'zod';
export declare class StoresController {
    private readonly storesService;
    constructor(storesService: StoresService);
    create(tenantId: string, body: z.infer<typeof createStoreBodySchema>): Promise<{
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
    update(tenantId: string, id: string, body: z.infer<typeof patchStoreBodySchema>): Promise<{
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
