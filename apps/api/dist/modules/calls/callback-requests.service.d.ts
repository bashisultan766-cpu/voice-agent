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
    }>;
    listForTenant(tenantId: string, options?: {
        status?: CallbackRequestStatus;
        limit?: number;
    }): Promise<{
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
    updateStatus(tenantId: string, id: string, status: CallbackRequestStatus): Promise<{
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
    markRequestedOnSession(callSessionId: string): Promise<void>;
}
export {};
