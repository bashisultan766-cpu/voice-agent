import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { EncryptionService } from '../../common/encryption.service';
import { CallsService } from '../calls/calls.service';
import { SessionContextService } from '../calls/runtime/session-context.service';
import { ToolOrchestratorService } from '../calls/runtime/tool-orchestrator.service';
import { ShopifyProductSyncService } from '../integrations/shopify/product-sync';
import { ResendEmailService } from '../integrations/email/resend-email.service';
import { Prisma } from '@prisma/client';
import { OpenAIConnectionTestService } from '../agents/connection-test/openai-connection-test.service';
import { TwilioConnectionTestService } from '../agents/connection-test/twilio-connection-test.service';
export declare class OpsService {
    private readonly prisma;
    private readonly config;
    private readonly encryption;
    private readonly callsService;
    private readonly sessionContext;
    private readonly toolOrchestrator;
    private readonly shopifySync;
    private readonly resendEmail;
    private readonly openaiTest;
    private readonly twilioTest;
    constructor(prisma: PrismaService, config: ConfigService, encryption: EncryptionService, callsService: CallsService, sessionContext: SessionContextService, toolOrchestrator: ToolOrchestratorService, shopifySync: ShopifyProductSyncService, resendEmail: ResendEmailService, openaiTest: OpenAIConnectionTestService, twilioTest: TwilioConnectionTestService);
    private decryptSecretsBlob;
    private normalizeUrlNoSlash;
    getAgentsOverview(tenantId: string): Prisma.PrismaPromise<{
        voiceProfile: {
            id: string;
            tenantId: string;
            createdAt: Date;
            updatedAt: Date;
            language: string;
            voice: string | null;
            greetingMessage: string | null;
            agentId: string;
            provider: string;
            tone: string | null;
            providerConfig: Prisma.JsonValue | null;
        } | null;
        id: string;
        updatedAt: Date;
        name: string;
        status: import("@prisma/client").$Enums.AgentStatus;
        shopifyConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        twilioConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        openaiConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
    }[]>;
    getCalls(tenantId: string): Prisma.PrismaPromise<({
        agent: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.CallStatus;
        storeId: string | null;
        agentId: string;
        metadata: Prisma.JsonValue | null;
        twilioCallSid: string | null;
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
        openaiSessionId: string | null;
        endedReason: string | null;
    })[]>;
    getTranscripts(tenantId: string, callSessionId: string): Prisma.PrismaPromise<{
        id: string;
        role: string;
        createdAt: Date;
        callSessionId: string;
        content: string;
        sequenceNumber: number;
        timestampMs: number | null;
    }[]>;
    getCheckoutLinks(tenantId: string): Prisma.PrismaPromise<({
        agent: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.CheckoutLinkStatus;
        agentId: string;
        metadata: Prisma.JsonValue | null;
        callSessionId: string | null;
        sentAt: Date | null;
        checkoutFingerprint: string | null;
        shopifyConnectionId: string | null;
        mode: import("@prisma/client").$Enums.CheckoutMode;
        checkoutUrl: string;
        customerEmail: string | null;
        itemsJson: Prisma.JsonValue | null;
        providerRef: string | null;
        expiresAt: Date | null;
        completedAt: Date | null;
    })[]>;
    getLeads(tenantId: string): Prisma.PrismaPromise<({
        agent: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        agentId: string;
        metadata: Prisma.JsonValue | null;
        callSessionId: string | null;
        customerEmail: string | null;
        notes: string | null;
        customerName: string | null;
        customerPhone: string | null;
        intent: string | null;
        interestedItems: Prisma.JsonValue | null;
    })[]>;
    getEmailEvents(tenantId: string): Prisma.PrismaPromise<({
        agent: {
            id: string;
            name: string;
        };
    } & {
        id: string;
        tenantId: string;
        createdAt: Date;
        updatedAt: Date;
        status: import("@prisma/client").$Enums.EmailDeliveryStatus;
        agentId: string;
        metadata: Prisma.JsonValue | null;
        callSessionId: string | null;
        checkoutLinkId: string | null;
        idempotencyKey: string | null;
        recipientEmail: string;
        subject: string;
        provider: string;
        providerMessageId: string | null;
        bodyPreview: string | null;
        sentAt: Date | null;
    })[]>;
    getPayments(tenantId: string): Prisma.PrismaPromise<({
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
        createdAt: Date;
        updatedAt: Date;
        agentId: string;
        metadata: Prisma.JsonValue | null;
        callSessionId: string | null;
        checkoutLinkId: string;
        customerEmail: string | null;
        shopifyOrderId: string | null;
        shopifyOrderName: string | null;
        paymentStatus: import("@prisma/client").$Enums.PaymentLifecycleStatus;
        paidAt: Date | null;
        failedAt: Date | null;
        expiredAt: Date | null;
        webhookEventKey: string | null;
        lastWebhookTopic: string | null;
        rawWebhookPayloadJson: Prisma.JsonValue | null;
    })[]>;
    simulateToolCall(tenantId: string, agentId: string, input: {
        toolName: string;
        args?: Record<string, unknown>;
        callSessionId?: string;
    }): Promise<{
        ok: boolean;
        callSessionId: string;
        toolName: string;
        result: import("../calls/runtime/tool-orchestrator.service").ToolResult;
    }>;
    syncProductsManual(tenantId: string, agentId: string): Promise<{
        syncedProducts: number;
        syncedVariants: number;
        shopDomain: string;
        ok: boolean;
        agentId: string;
    }>;
    sendDevelopmentTestEmail(tenantId: string, agentId: string, body: {
        toEmail: string;
        checkoutUrl?: string;
    }): Promise<{
        ok: boolean;
        checkoutLinkId: string;
        emailEventId: string;
        reusedCheckout: boolean;
        deduplicatedEmail: boolean;
    }>;
    simulateBuyingFlow(tenantId: string, agentId: string, body: {
        query?: string;
        customerEmail?: string;
        sendEmail?: boolean;
        checkoutMode?: 'STOREFRONT_CART' | 'DRAFT_ORDER_INVOICE';
        callSessionId?: string;
    }): Promise<{
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
    fullReadinessSmoke(tenantId: string, agentId: string, body: {
        query?: string;
        customerEmail?: string;
        runFlowSimulation?: boolean;
        sendEmail?: boolean;
        checkoutMode?: 'STOREFRONT_CART' | 'DRAFT_ORDER_INVOICE';
        callSessionId?: string;
    }): Promise<{
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
    private assertDevOpsEndpointsAllowed;
    private normalizeShopHost;
    private assertHttpsCheckoutUrlMatchesAgentShop;
    private readDataObject;
}
