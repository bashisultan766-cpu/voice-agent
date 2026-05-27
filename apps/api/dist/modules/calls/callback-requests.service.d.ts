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
    }>;
    listForTenant(tenantId: string, options?: {
        status?: CallbackRequestStatus;
        limit?: number;
    }): Promise<{
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
    updateStatus(tenantId: string, id: string, status: CallbackRequestStatus): Promise<{
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
    markRequestedOnSession(callSessionId: string): Promise<void>;
}
export {};
