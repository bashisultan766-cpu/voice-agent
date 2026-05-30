import { CallbackRequestStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
interface CreateCallbackRequestInput {
    tenantId: string;
    agentId: string;
    callSessionId?: string;
    phone: string;
    reason: string;
    priority?: 'low' | 'normal' | 'high';
    notes?: string;
}
export declare class CallbackRequestsService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    create(input: CreateCallbackRequestInput): Promise<{
        reason: string;
        id: string;
        tenantId: string;
        agentId: string;
        status: import("@prisma/client").$Enums.CallbackRequestStatus;
        createdAt: Date;
        updatedAt: Date;
        callSessionId: string | null;
        notes: string | null;
        phone: string;
        priority: string | null;
    }>;
    listForTenant(tenantId: string, options?: {
        status?: CallbackRequestStatus;
        limit?: number;
    }): Promise<{
        reason: string;
        id: string;
        tenantId: string;
        agentId: string;
        status: import("@prisma/client").$Enums.CallbackRequestStatus;
        createdAt: Date;
        updatedAt: Date;
        callSessionId: string | null;
        notes: string | null;
        phone: string;
        priority: string | null;
    }[]>;
    updateStatus(tenantId: string, id: string, status: CallbackRequestStatus): Promise<{
        reason: string;
        id: string;
        tenantId: string;
        agentId: string;
        status: import("@prisma/client").$Enums.CallbackRequestStatus;
        createdAt: Date;
        updatedAt: Date;
        callSessionId: string | null;
        notes: string | null;
        phone: string;
        priority: string | null;
    } | null>;
    markRequestedOnSession(callSessionId: string): Promise<void>;
}
export {};
