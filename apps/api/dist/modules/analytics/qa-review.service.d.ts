import { PrismaService } from '../../database/prisma.service';
export declare class QaReviewService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    listCallsForQa(tenantId: string, options?: {
        limit?: number;
        hasOutcome?: boolean;
    }): Promise<({
        store: {
            name: string;
            id: string;
        } | null;
        agent: {
            name: string;
            id: string;
        };
        callOutcome: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            tenantId: string;
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
            productsRequested: import("@prisma/client/runtime/client").JsonValue | null;
            conversionOutcome: string | null;
            paymentLinkSent: boolean;
            orderCompleted: boolean;
            escalationReason: string | null;
            analyticsMeta: import("@prisma/client/runtime/client").JsonValue | null;
        } | null;
        _count: {
            toolExecutions: number;
        };
    } & {
        status: import("@prisma/client").$Enums.CallStatus;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        storeId: string | null;
        agentId: string;
        metadata: import("@prisma/client/runtime/client").JsonValue | null;
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
        store: {
            name: string;
            id: string;
        } | null;
        agent: {
            name: string;
            id: string;
            baseSystemPrompt: string;
        };
        callOutcome: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            tenantId: string;
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
            productsRequested: import("@prisma/client/runtime/client").JsonValue | null;
            conversionOutcome: string | null;
            paymentLinkSent: boolean;
            orderCompleted: boolean;
            escalationReason: string | null;
            analyticsMeta: import("@prisma/client/runtime/client").JsonValue | null;
        } | null;
        toolExecutions: {
            status: import("@prisma/client").$Enums.ToolExecutionStatus;
            id: string;
            createdAt: Date;
            tenantId: string;
            agentId: string;
            callSessionId: string | null;
            requestId: string | null;
            toolName: string;
            inputJson: import("@prisma/client/runtime/client").JsonValue;
            outputJson: import("@prisma/client/runtime/client").JsonValue | null;
            errorMessage: string | null;
            latencyMs: number | null;
        }[];
        transcripts: {
            id: string;
            createdAt: Date;
            callSessionId: string;
            sequenceNumber: number;
            role: string;
            content: string;
            timestampMs: number | null;
        }[];
        callEvents: {
            type: import("@prisma/client").$Enums.CallEventType;
            id: string;
            createdAt: Date;
            tenantId: string;
            callSessionId: string;
            timestamp: Date;
            payload: import("@prisma/client/runtime/client").JsonValue | null;
        }[];
    } & {
        status: import("@prisma/client").$Enums.CallStatus;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        storeId: string | null;
        agentId: string;
        metadata: import("@prisma/client/runtime/client").JsonValue | null;
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
        createdAt: Date;
        tenantId: string;
        agentId: string;
        callSessionId: string;
        reviewerUserId: string | null;
        accuracyScore: number | null;
        toneScore: number | null;
        policyComplianceScore: number | null;
        brevityScore: number | null;
        notes: string | null;
        needsPromptUpdate: boolean;
        needsFaqUpdate: boolean;
    }>;
}
