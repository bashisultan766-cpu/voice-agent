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
        status: import("@prisma/client").$Enums.CallbackRequestStatus;
        reason: string;
        callSessionId: string | null;
        phone: string;
        priority: string | null;
        agentId: string;
        notes: string | null;
    }[]>;
    updateStatus(tenantId: string, id: string, body: z.infer<typeof callbackPatchStatusBodySchema>): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.CallbackRequestStatus;
        reason: string;
        callSessionId: string | null;
        phone: string;
        priority: string | null;
        agentId: string;
        notes: string | null;
    } | null>;
}
