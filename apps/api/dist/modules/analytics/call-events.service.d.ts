import { PrismaService } from '../../database/prisma.service';
import { CallEventType, Prisma } from '@prisma/client';
export declare class CallEventsService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    log(tenantId: string, callSessionId: string, type: CallEventType, payload?: Record<string, unknown>): Promise<void>;
    getByCallSession(callSessionId: string, tenantId?: string): Promise<{
        type: import("@prisma/client").$Enums.CallEventType;
        id: string;
        createdAt: Date;
        tenantId: string;
        callSessionId: string;
        timestamp: Date;
        payload: Prisma.JsonValue | null;
    }[]>;
}
