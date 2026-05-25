import { StoresService } from './stores.service';
import { createStoreBodySchema, patchStoreBodySchema } from './stores-validation';
import type { z } from 'zod';
export declare class StoresController {
    private readonly storesService;
    constructor(storesService: StoresService);
    create(tenantId: string, body: z.infer<typeof createStoreBodySchema>): Promise<{
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
    update(tenantId: string, id: string, body: z.infer<typeof patchStoreBodySchema>): Promise<{
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
