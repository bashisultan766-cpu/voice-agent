import { PrismaService } from '../../database/prisma.service';
import { CallResolutionStatus } from '@prisma/client';
export declare class CallOutcomeService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    deriveAndUpsert(callSessionId: string): Promise<void>;
    getByCallSession(callSessionId: string): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        summary: string | null;
        escalated: boolean;
        callSessionId: string;
        callbackRequested: boolean;
        resolutionStatus: import("@prisma/client").$Enums.CallResolutionStatus;
        primaryIntent: string | null;
        secondaryIntent: string | null;
        customerVerified: boolean;
        toolsUsedCount: number;
        toolFailuresCount: number;
        fallbackCount: number;
        qaScore: number | null;
    } | null>;
    update(tenantId: string, callSessionId: string, data: {
        resolutionStatus?: CallResolutionStatus;
        primaryIntent?: string;
        secondaryIntent?: string;
        summary?: string;
        qaScore?: number;
    }): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        summary: string | null;
        escalated: boolean;
        callSessionId: string;
        callbackRequested: boolean;
        resolutionStatus: import("@prisma/client").$Enums.CallResolutionStatus;
        primaryIntent: string | null;
        secondaryIntent: string | null;
        customerVerified: boolean;
        toolsUsedCount: number;
        toolFailuresCount: number;
        fallbackCount: number;
        qaScore: number | null;
    } | null>;
}
