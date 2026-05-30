import { StoresService } from './stores.service';
import { createStoreBodySchema, patchStoreBodySchema } from './stores-validation';
import type { z } from 'zod';
export declare class StoresController {
    private readonly storesService;
    constructor(storesService: StoresService);
    create(tenantId: string, body: z.infer<typeof createStoreBodySchema>): Promise<{
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
    update(tenantId: string, id: string, body: z.infer<typeof patchStoreBodySchema>): Promise<{
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
