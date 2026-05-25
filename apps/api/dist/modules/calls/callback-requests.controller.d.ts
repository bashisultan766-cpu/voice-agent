import { CallbackRequestsService } from './callback-requests.service';
import { callbackListQuerySchema, callbackPatchStatusBodySchema } from './callback-requests-validation';
import type { z } from 'zod';
export declare class CallbackRequestsController {
    private readonly callbacks;
    constructor(callbacks: CallbackRequestsService);
    list(tenantId: string, query: z.infer<typeof callbackListQuerySchema>): Promise<{
        reason: string;
        phone: string;
        priority: string | null;
        id: string;
        tenantId: string;
        status: import("@prisma/client").$Enums.CallbackRequestStatus;
        createdAt: Date;
        updatedAt: Date;
        agentId: string;
        callSessionId: string | null;
        notes: string | null;
    }[]>;
    updateStatus(tenantId: string, id: string, body: z.infer<typeof callbackPatchStatusBodySchema>): Promise<{
        reason: string;
        phone: string;
        priority: string | null;
        id: string;
        tenantId: string;
        status: import("@prisma/client").$Enums.CallbackRequestStatus;
        createdAt: Date;
        updatedAt: Date;
        agentId: string;
        callSessionId: string | null;
        notes: string | null;
    } | null>;
}
