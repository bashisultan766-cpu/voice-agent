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
    }>;
    listForTenant(tenantId: string, options?: {
        status?: CallbackRequestStatus;
        limit?: number;
    }): Promise<{
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
    updateStatus(tenantId: string, id: string, status: CallbackRequestStatus): Promise<{
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
    markRequestedOnSession(callSessionId: string): Promise<void>;
}
export {};
