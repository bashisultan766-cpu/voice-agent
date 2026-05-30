import { PrismaService } from '../../database/prisma.service';
export declare class QaReviewService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    listCallsForQa(tenantId: string, options?: {
        limit?: number;
        hasOutcome?: boolean;
    }): Promise<({
        agent: {
            id: string;
            name: string;
        };
        store: {
            id: string;
            name: string;
        } | null;
        callOutcome: {
            id: string;
            tenantId: string;
            summary: string | null;
            escalated: boolean;
            createdAt: Date;
            updatedAt: Date;
            callSessionId: string;
            paymentLinkSent: boolean;
            callbackRequested: boolean;
            resolutionStatus: import("@prisma/client").$Enums.CallResolutionStatus;
            primaryIntent: string | null;
            secondaryIntent: string | null;
            customerVerified: boolean;
            toolsUsedCount: number;
            toolFailuresCount: number;
            fallbackCount: number;
            qaScore: number | null;
            productsRequested: import("@prisma/client/runtime/client").JsonValue | null;
            conversionOutcome: string | null;
            orderCompleted: boolean;
            escalationReason: string | null;
            analyticsMeta: import("@prisma/client/runtime/client").JsonValue | null;
        } | null;
        _count: {
            toolExecutions: number;
        };
    } & {
        id: string;
        twilioCallSid: string | null;
        tenantId: string;
        storeId: string | null;
        agentId: string;
        phoneNumberId: string | null;
        twilioStreamSid: string | null;
        fromNumber: string | null;
        toNumber: string | null;
        status: import("@prisma/client").$Enums.CallStatus;
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
        metadata: import("@prisma/client/runtime/client").JsonValue | null;
        openaiSessionId: string | null;
        endedReason: string | null;
        createdAt: Date;
        updatedAt: Date;
    })[]>;
    getQaDetail(callSessionId: string, tenantId: string): Promise<{
        agent: {
            id: string;
            name: string;
            baseSystemPrompt: string;
        };
        store: {
            id: string;
            name: string;
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
        toolExecutions: {
            id: string;
            tenantId: string;
            agentId: string;
            status: import("@prisma/client").$Enums.ToolExecutionStatus;
            createdAt: Date;
            callSessionId: string | null;
            latencyMs: number | null;
            toolName: string;
            errorMessage: string | null;
            requestId: string | null;
            inputJson: import("@prisma/client/runtime/client").JsonValue;
            outputJson: import("@prisma/client/runtime/client").JsonValue | null;
        }[];
        callEvents: {
            id: string;
            tenantId: string;
            createdAt: Date;
            callSessionId: string;
            type: import("@prisma/client").$Enums.CallEventType;
            payload: import("@prisma/client/runtime/client").JsonValue | null;
            timestamp: Date;
        }[];
        callOutcome: {
            id: string;
            tenantId: string;
            summary: string | null;
            escalated: boolean;
            createdAt: Date;
            updatedAt: Date;
            callSessionId: string;
            paymentLinkSent: boolean;
            callbackRequested: boolean;
            resolutionStatus: import("@prisma/client").$Enums.CallResolutionStatus;
            primaryIntent: string | null;
            secondaryIntent: string | null;
            customerVerified: boolean;
            toolsUsedCount: number;
            toolFailuresCount: number;
            fallbackCount: number;
            qaScore: number | null;
            productsRequested: import("@prisma/client/runtime/client").JsonValue | null;
            conversionOutcome: string | null;
            orderCompleted: boolean;
            escalationReason: string | null;
            analyticsMeta: import("@prisma/client/runtime/client").JsonValue | null;
        } | null;
    } & {
        id: string;
        twilioCallSid: string | null;
        tenantId: string;
        storeId: string | null;
        agentId: string;
        phoneNumberId: string | null;
        twilioStreamSid: string | null;
        fromNumber: string | null;
        toNumber: string | null;
        status: import("@prisma/client").$Enums.CallStatus;
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
        metadata: import("@prisma/client/runtime/client").JsonValue | null;
        openaiSessionId: string | null;
        endedReason: string | null;
        createdAt: Date;
        updatedAt: Date;
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
        agentId: string;
        createdAt: Date;
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
