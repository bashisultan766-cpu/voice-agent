import type { z } from 'zod';
import { OpsService } from './ops.service';
import { fullReadinessSmokeBodySchema, simulateBuyingFlowBodySchema, simulateToolBodySchema, testEmailBodySchema } from './ops-validation';
export declare class OpsController {
    private readonly ops;
    constructor(ops: OpsService);
    getAgents(tenantId: string): import("@prisma/client").Prisma.PrismaPromise<{
        id: string;
        status: import("@prisma/client").$Enums.AgentStatus;
        updatedAt: Date;
        name: string;
        shopifyConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        twilioConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        openaiConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        voiceProfile: {
            id: string;
            tenantId: string;
            agentId: string;
            createdAt: Date;
            updatedAt: Date;
            language: string;
            voice: string | null;
            greetingMessage: string | null;
            provider: string;
            tone: string | null;
            providerConfig: import("@prisma/client/runtime/client").JsonValue | null;
        } | null;
    }[]>;
    getCalls(tenantId: string): import("@prisma/client").Prisma.PrismaPromise<({
        agent: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        tenantId: string;
        agentId: string;
        status: import("@prisma/client").$Enums.CallStatus;
        createdAt: Date;
        updatedAt: Date;
        twilioCallSid: string | null;
        storeId: string | null;
        phoneNumberId: string | null;
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
        metadata: import("@prisma/client/runtime/client").JsonValue | null;
        openaiSessionId: string | null;
        endedReason: string | null;
    })[]>;
    getTranscripts(tenantId: string, callSessionId: string): import("@prisma/client").Prisma.PrismaPromise<{
        id: string;
        createdAt: Date;
        callSessionId: string;
        role: string;
        content: string;
        sequenceNumber: number;
        timestampMs: number | null;
    }[]>;
    getCheckoutLinks(tenantId: string): import("@prisma/client").Prisma.PrismaPromise<({
        agent: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        tenantId: string;
        agentId: string;
        status: import("@prisma/client").$Enums.CheckoutLinkStatus;
        createdAt: Date;
        updatedAt: Date;
        metadata: import("@prisma/client/runtime/client").JsonValue | null;
        mode: import("@prisma/client").$Enums.CheckoutMode;
        callSessionId: string | null;
        checkoutFingerprint: string | null;
        shopifyConnectionId: string | null;
        checkoutUrl: string;
        customerEmail: string | null;
        itemsJson: import("@prisma/client/runtime/client").JsonValue | null;
        providerRef: string | null;
        expiresAt: Date | null;
        sentAt: Date | null;
        completedAt: Date | null;
    })[]>;
    getLeads(tenantId: string): import("@prisma/client").Prisma.PrismaPromise<({
        agent: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        tenantId: string;
        agentId: string;
        createdAt: Date;
        updatedAt: Date;
        metadata: import("@prisma/client/runtime/client").JsonValue | null;
        customerName: string | null;
        callSessionId: string | null;
        customerEmail: string | null;
        customerPhone: string | null;
        intent: string | null;
        interestedItems: import("@prisma/client/runtime/client").JsonValue | null;
        notes: string | null;
    })[]>;
    getEmailEvents(tenantId: string): import("@prisma/client").Prisma.PrismaPromise<({
        agent: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        tenantId: string;
        agentId: string;
        status: import("@prisma/client").$Enums.EmailDeliveryStatus;
        createdAt: Date;
        updatedAt: Date;
        metadata: import("@prisma/client/runtime/client").JsonValue | null;
        callSessionId: string | null;
        sentAt: Date | null;
        checkoutLinkId: string | null;
        provider: string;
        idempotencyKey: string | null;
        recipientEmail: string;
        subject: string;
        providerMessageId: string | null;
        bodyPreview: string | null;
    })[]>;
    getPayments(tenantId: string): import("@prisma/client").Prisma.PrismaPromise<({
        agent: {
            id: string;
            name: string;
        };
        checkoutLink: {
            id: string;
            callSessionId: string | null;
            checkoutUrl: string;
        };
    } & {
        id: string;
        tenantId: string;
        agentId: string;
        createdAt: Date;
        updatedAt: Date;
        metadata: import("@prisma/client/runtime/client").JsonValue | null;
        callSessionId: string | null;
        customerEmail: string | null;
        checkoutLinkId: string;
        shopifyOrderId: string | null;
        shopifyOrderName: string | null;
        paymentStatus: import("@prisma/client").$Enums.PaymentLifecycleStatus;
        paidAt: Date | null;
        failedAt: Date | null;
        expiredAt: Date | null;
        webhookEventKey: string | null;
        lastWebhookTopic: string | null;
        rawWebhookPayloadJson: import("@prisma/client/runtime/client").JsonValue | null;
    })[]>;
    simulateTool(tenantId: string, agentId: string, body: z.infer<typeof simulateToolBodySchema>): Promise<{
        ok: boolean;
        callSessionId: string;
        toolName: string;
        result: import("../calls/runtime/tool-orchestrator.service").ToolResult;
    }>;
    syncProducts(tenantId: string, agentId: string): Promise<{
        syncedProducts: number;
        syncedVariants: number;
        shopDomain: string;
        ok: boolean;
        agentId: string;
    }>;
    sendTestEmail(tenantId: string, agentId: string, body: z.infer<typeof testEmailBodySchema>): Promise<{
        ok: boolean;
        checkoutLinkId: string;
        emailEventId: string;
        reusedCheckout: boolean;
        deduplicatedEmail: boolean;
    }>;
    simulateBuyingFlow(tenantId: string, agentId: string, body: z.infer<typeof simulateBuyingFlowBodySchema>): Promise<{
        ok: boolean;
        reason: string;
        steps: {
            step: string;
            output: unknown;
        }[];
        callSessionId?: undefined;
        emailSent?: undefined;
    } | {
        ok: boolean;
        callSessionId: string;
        emailSent: boolean;
        steps: {
            step: string;
            output: unknown;
        }[];
        reason?: undefined;
    }>;
    fullReadinessSmoke(tenantId: string, agentId: string, body: z.infer<typeof fullReadinessSmokeBodySchema>): Promise<{
        ok: boolean;
        agentId: string;
        agentName: string;
        summary: {
            passed: number;
            failed: number;
        };
        expectedTwilioWebhook: {
            inbound: string;
            status: string;
            method: string;
        };
        observedTwilioWebhook: {
            voiceUrl: string | null;
            voiceMethod: string | null;
            statusCallback: string | null;
            statusCallbackMethod: string | null;
        } | null;
        checks: {
            key: string;
            pass: boolean;
            details: string;
        }[];
        flowSimulation: unknown;
    }>;
}
