import { StoresService } from './stores.service';
import { createStoreBodySchema, patchStoreBodySchema } from './stores-validation';
import type { z } from 'zod';
export declare class StoresController {
    private readonly storesService;
    constructor(storesService: StoresService);
    create(tenantId: string, body: z.infer<typeof createStoreBodySchema>): Promise<{
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
    update(tenantId: string, id: string, body: z.infer<typeof patchStoreBodySchema>): Promise<{
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
