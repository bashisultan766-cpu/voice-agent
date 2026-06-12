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
            createdAt: Date;
            tenantId: string;
            updatedAt: Date;
            callSessionId: string;
            summary: string | null;
            escalated: boolean;
            paymentLinkSent: boolean;
            fallbackCount: number;
            resolutionStatus: import("@prisma/client").$Enums.CallResolutionStatus;
            primaryIntent: string | null;
            secondaryIntent: string | null;
            customerVerified: boolean;
            toolsUsedCount: number;
            toolFailuresCount: number;
            callbackRequested: boolean;
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
        createdAt: Date;
        tenantId: string;
        agentId: string;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.CallStatus;
        metadata: import("@prisma/client/runtime/client").JsonValue | null;
        direction: string | null;
        storeId: string | null;
        phoneNumberId: string | null;
        twilioCallSid: string | null;
        twilioStreamSid: string | null;
        fromNumber: string | null;
        toNumber: string | null;
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
            id: string;
            name: string;
            baseSystemPrompt: string;
        };
        store: {
            id: string;
            name: string;
        } | null;
        callOutcome: {
            id: string;
            createdAt: Date;
            tenantId: string;
            updatedAt: Date;
            callSessionId: string;
            summary: string | null;
            escalated: boolean;
            paymentLinkSent: boolean;
            fallbackCount: number;
            resolutionStatus: import("@prisma/client").$Enums.CallResolutionStatus;
            primaryIntent: string | null;
            secondaryIntent: string | null;
            customerVerified: boolean;
            toolsUsedCount: number;
            toolFailuresCount: number;
            callbackRequested: boolean;
            qaScore: number | null;
            productsRequested: import("@prisma/client/runtime/client").JsonValue | null;
            conversionOutcome: string | null;
            orderCompleted: boolean;
            escalationReason: string | null;
            analyticsMeta: import("@prisma/client/runtime/client").JsonValue | null;
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
            createdAt: Date;
            tenantId: string;
            agentId: string;
            errorMessage: string | null;
            callSessionId: string | null;
            status: import("@prisma/client").$Enums.ToolExecutionStatus;
            latencyMs: number | null;
            toolName: string;
            requestId: string | null;
            inputJson: import("@prisma/client/runtime/client").JsonValue;
            outputJson: import("@prisma/client/runtime/client").JsonValue | null;
        }[];
        callEvents: {
            id: string;
            createdAt: Date;
            tenantId: string;
            callSessionId: string;
            type: import("@prisma/client").$Enums.CallEventType;
            payload: import("@prisma/client/runtime/client").JsonValue | null;
            timestamp: Date;
        }[];
    } & {
        id: string;
        createdAt: Date;
        tenantId: string;
        agentId: string;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.CallStatus;
        metadata: import("@prisma/client/runtime/client").JsonValue | null;
        direction: string | null;
        storeId: string | null;
        phoneNumberId: string | null;
        twilioCallSid: string | null;
        twilioStreamSid: string | null;
        fromNumber: string | null;
        toNumber: string | null;
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
