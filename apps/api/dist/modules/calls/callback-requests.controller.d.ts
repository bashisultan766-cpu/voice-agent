import { CallbackRequestsService } from './callback-requests.service';
import { callbackListQuerySchema, callbackPatchStatusBodySchema } from './callback-requests-validation';
import type { z } from 'zod';
export declare class CallbackRequestsController {
    private readonly callbacks;
    constructor(callbacks: CallbackRequestsService);
    list(tenantId: string, query: z.infer<typeof callbackListQuerySchema>): Promise<{
        id: string;
        createdAt: Date;
        tenantId: string;
        agentId: string;
        updatedAt: Date;
        reason: string;
        callSessionId: string | null;
        status: import("@prisma/client").$Enums.CallbackRequestStatus;
        phone: string;
        notes: string | null;
        priority: string | null;
    }[]>;
    updateStatus(tenantId: string, id: string, body: z.infer<typeof callbackPatchStatusBodySchema>): Promise<{
        id: string;
        createdAt: Date;
        tenantId: string;
        agentId: string;
        updatedAt: Date;
        reason: string;
        callSessionId: string | null;
        status: import("@prisma/client").$Enums.CallbackRequestStatus;
        phone: string;
        notes: string | null;
        priority: string | null;
    } | null>;
}
