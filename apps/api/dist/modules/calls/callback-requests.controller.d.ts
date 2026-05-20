import { CallbackRequestsService } from './callback-requests.service';
import { callbackListQuerySchema, callbackPatchStatusBodySchema } from './callback-requests-validation';
import type { z } from 'zod';
export declare class CallbackRequestsController {
    private readonly callbacks;
    constructor(callbacks: CallbackRequestsService);
    list(tenantId: string, query: z.infer<typeof callbackListQuerySchema>): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        reason: string;
        status: import("@prisma/client").$Enums.CallbackRequestStatus;
        phone: string;
        agentId: string;
        callSessionId: string | null;
        priority: string | null;
        notes: string | null;
    }[]>;
    updateStatus(tenantId: string, id: string, body: z.infer<typeof callbackPatchStatusBodySchema>): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        reason: string;
        status: import("@prisma/client").$Enums.CallbackRequestStatus;
        phone: string;
        agentId: string;
        callSessionId: string | null;
        priority: string | null;
        notes: string | null;
    } | null>;
}
