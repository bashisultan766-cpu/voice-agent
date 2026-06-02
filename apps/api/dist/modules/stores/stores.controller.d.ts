import { StoresService } from './stores.service';
import { createStoreBodySchema, patchStoreBodySchema } from './stores-validation';
import type { z } from 'zod';
export declare class StoresController {
    private readonly storesService;
    constructor(storesService: StoresService);
    create(tenantId: string, body: z.infer<typeof createStoreBodySchema>): Promise<{
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
    update(tenantId: string, id: string, body: z.infer<typeof patchStoreBodySchema>): Promise<{
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
