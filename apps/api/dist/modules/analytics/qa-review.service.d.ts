import { PrismaService } from '../../database/prisma.service';
export declare class QaReviewService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    listCallsForQa(tenantId: string, options?: {
        limit?: number;
        hasOutcome?: boolean;
    }): Promise<({
        agent: {
            name: string;
            id: string;
        };
        store: {
            name: string;
            id: string;
        } | null;
        _count: {
            toolExecutions: number;
        };
        callOutcome: {
            id: string;
            tenantId: string;
            createdAt: Date;
            updatedAt: Date;
            summary: string | null;
            escalated: boolean;
            callSessionId: string;
            resolutionStatus: import("@prisma/client").$Enums.CallResolutionStatus;
            primaryIntent: string | null;
            secondaryIntent: string | null;
            customerVerified: boolean;
            toolsUsedCount: number;
            toolFailuresCount: number;
            fallbackCount: number;
            callbackRequested: boolean;
            qaScore: number | null;
            productsRequested: import("@prisma/client/runtime/library").JsonValue | null;
            conversionOutcome: string | null;
            paymentLinkSent: boolean;
            orderCompleted: boolean;
            escalationReason: string | null;
            analyticsMeta: import("@prisma/client/runtime/library").JsonValue | null;
        } | null;
    } & {
        id: string;
        tenantId: string;
        storeId: string | null;
        status: import("@prisma/client").$Enums.CallStatus;
        createdAt: Date;
        updatedAt: Date;
        agentId: string;
        metadata: import("@prisma/client/runtime/library").JsonValue | null;
        phoneNumberId: string | null;
        twilioCallSid: string | null;
        twilioStreamSid: string | null;
        fromNumber: string | null;
        toNumber: string | null;
        direction: string | null;
        startedAt: Date | null;
        answeredAt: Date | null;
        endedAt: Date | null;
        durationSeconds: number | null;
        transcriptText: string | null;
        summary: string | null;
        sentiment: string | null;
        escalated: boolean;
        recordingUrl: string | null;
        lastEventAt: Date | null;
        openaiSessionId: string | null;
        endedReason: string | null;
    })[]>;
    getQaDetail(callSessionId: string, tenantId: string): Promise<{
        agent: {
            name: string;
            id: string;
            baseSystemPrompt: string;
        };
        store: {
            name: string;
            id: string;
        } | null;
        toolExecutions: {
            id: string;
            tenantId: string;
            status: import("@prisma/client").$Enums.ToolExecutionStatus;
            createdAt: Date;
            agentId: string;
            callSessionId: string | null;
            requestId: string | null;
            toolName: string;
            inputJson: import("@prisma/client/runtime/library").JsonValue;
            outputJson: import("@prisma/client/runtime/library").JsonValue | null;
            errorMessage: string | null;
            latencyMs: number | null;
        }[];
        callOutcome: {
            id: string;
            tenantId: string;
            createdAt: Date;
            updatedAt: Date;
            summary: string | null;
            escalated: boolean;
            callSessionId: string;
            resolutionStatus: import("@prisma/client").$Enums.CallResolutionStatus;
            primaryIntent: string | null;
            secondaryIntent: string | null;
            customerVerified: boolean;
            toolsUsedCount: number;
            toolFailuresCount: number;
            fallbackCount: number;
            callbackRequested: boolean;
            qaScore: number | null;
            productsRequested: import("@prisma/client/runtime/library").JsonValue | null;
            conversionOutcome: string | null;
            paymentLinkSent: boolean;
            orderCompleted: boolean;
            escalationReason: string | null;
            analyticsMeta: import("@prisma/client/runtime/library").JsonValue | null;
        } | null;
        transcripts: {
            id: string;
            createdAt: Date;
            callSessionId: string;
            role: string;
            content: string;
            sequenceNumber: number;
            timestampMs: number | null;
        }[];
        callEvents: {
            type: import("@prisma/client").$Enums.CallEventType;
            id: string;
            tenantId: string;
            createdAt: Date;
            callSessionId: string;
            timestamp: Date;
            payload: import("@prisma/client/runtime/library").JsonValue | null;
        }[];
    } & {
        id: string;
        tenantId: string;
        storeId: string | null;
        status: import("@prisma/client").$Enums.CallStatus;
        createdAt: Date;
        updatedAt: Date;
        agentId: string;
        metadata: import("@prisma/client/runtime/library").JsonValue | null;
        phoneNumberId: string | null;
        twilioCallSid: string | null;
        twilioStreamSid: string | null;
        fromNumber: string | null;
        toNumber: string | null;
        direction: string | null;
        startedAt: Date | null;
        answeredAt: Date | null;
        endedAt: Date | null;
        durationSeconds: number | null;
        transcriptText: string | null;
        summary: string | null;
        sentiment: string | null;
        escalated: boolean;
        recordingUrl: string | null;
        lastEventAt: Date | null;
        openaiSessionId: string | null;
        endedReason: string | null;
    }>;
    submitReview(tenantId: string, callSessionId: string, data: {
        reviewerUserId?: string;
        accuracyScore?: number;
        toneScore?: number;
        policyComplianceScore?: number;
        brevityScore?: number;
        notes?: string;
        needsPromptUpdate?: boolean;
        needsFaqUpdate?: boolean;
    }): Promise<{
        id: string;
        tenantId: string;
        createdAt: Date;
        agentId: string;
        callSessionId: string;
        notes: string | null;
        reviewerUserId: string | null;
        accuracyScore: number | null;
        toneScore: number | null;
        policyComplianceScore: number | null;
        brevityScore: number | null;
        needsPromptUpdate: boolean;
        needsFaqUpdate: boolean;
    }>;
}
