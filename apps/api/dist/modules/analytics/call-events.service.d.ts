import { PrismaService } from '../../database/prisma.service';
import { CallEventType, Prisma } from '@prisma/client';
export declare class CallEventsService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    log(tenantId: string, callSessionId: string, type: CallEventType, payload?: Record<string, unknown>): Promise<void>;
    getByCallSession(callSessionId: string, tenantId?: string): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        callSessionId: string;
        type: import("@prisma/client").$Enums.CallEventType;
        timestamp: Date;
        payload: Prisma.JsonValue | null;
    }[]>;
}
