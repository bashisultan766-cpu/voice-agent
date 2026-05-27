import { CallbackRequestsService } from './callback-requests.service';
import { callbackListQuerySchema, callbackPatchStatusBodySchema } from './callback-requests-validation';
import type { z } from 'zod';
export declare class CallbackRequestsController {
    private readonly callbacks;
    constructor(callbacks: CallbackRequestsService);
    list(tenantId: string, query: z.infer<typeof callbackListQuerySchema>): Promise<{
        status: import("@prisma/client").$Enums.CallbackRequestStatus;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        phone: string;
        agentId: string;
        callSessionId: string | null;
        notes: string | null;
        reason: string;
        priority: string | null;
    }[]>;
    updateStatus(tenantId: string, id: string, body: z.infer<typeof callbackPatchStatusBodySchema>): Promise<{
        status: import("@prisma/client").$Enums.CallbackRequestStatus;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        phone: string;
        agentId: string;
        callSessionId: string | null;
        notes: string | null;
        reason: string;
        priority: string | null;
    } | null>;
}
