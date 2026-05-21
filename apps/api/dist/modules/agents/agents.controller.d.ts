import { AgentsService } from './agents.service';
import { ShopifyAgentService } from './shopify-agent.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { logsQuerySchema, testAiBehaviorBodySchema, testDatabaseCredentialsSchema, testElevenLabsCredentialsSchema, testOpenAiCredentialsSchema, testShopifyCredentialsSchema, testTwilioCredentialsSchema, configureTwilioWebhookBodySchema, smokeTestBodySchema, debugShopifySearchBodySchema } from './agents-validation';
import { z } from 'zod';
export declare class AgentsController {
    private readonly agentsService;
    private readonly shopifyAgent;
    constructor(agentsService: AgentsService, shopifyAgent: ShopifyAgentService);
    testShopifyCredentials(tenantId: string, dto: z.infer<typeof testShopifyCredentialsSchema>): Promise<{
        success: boolean;
        message: string;
        status?: import("@prisma/client").ConnectionStatus;
        provider: "shopify";
        source: "agent" | "workspace" | "env" | "missing";
    } | {
        success: boolean;
        message: string;
        code: string;
    }>;
    testDatabaseCredentials(tenantId: string, dto: z.infer<typeof testDatabaseCredentialsSchema>): Promise<{
        success: boolean;
        message: string;
        status?: import("@prisma/client").ConnectionStatus;
    }>;
    testTwilioCredentials(tenantId: string, dto: z.infer<typeof testTwilioCredentialsSchema>): Promise<{
        success: boolean;
        message: string;
        status?: import("@prisma/client").ConnectionStatus;
        provider: "twilio";
        source: "agent" | "workspace" | "env" | "missing";
    } | {
        success: boolean;
        message: string;
    }>;
    testOpenAICredentials(tenantId: string, dto: z.infer<typeof testOpenAiCredentialsSchema>): Promise<{
        success: boolean;
        message: string;
        status?: import("@prisma/client").ConnectionStatus;
        provider: "openai";
        source: "agent" | "workspace" | "env" | "missing";
        warnings?: string[];
    } | {
        success: boolean;
        message: string;
    }>;
    testElevenLabsCredentials(tenantId: string, dto: z.infer<typeof testElevenLabsCredentialsSchema>): Promise<{
        success: boolean;
        message: string;
        status?: import("@prisma/client").ConnectionStatus;
        provider: "elevenlabs";
        source: "agent" | "workspace" | "env" | "missing";
        warnings?: string[];
    } | {
        success: boolean;
        message: string;
    }>;
    create(tenantId: string, userId: string, dto: CreateAgentDto): Promise<{
        name: string;
        agentConfig: {
            supportEmail: string | null;
            supportPhone: string | null;
            businessName: string | null;
            askEmailBeforePaymentLink: boolean;
            checkoutMode: import("@prisma/client").$Enums.CheckoutMode;
            humanHandoffRules: string | null;
            shippingPolicy: string | null;
            returnPolicy: string | null;
            exchangePolicy: string | null;
            deliveryNotes: string | null;
            forbiddenBehaviors: string | null;
            escalationRules: string | null;
            fallbackHumanContact: string | null;
            customSystemPrompt: string | null;
        } | null;
        voiceProfile: {
            language: string;
            greetingMessage: string | null;
            provider: string;
            tone: string | null;
            providerConfig: import("@prisma/client/runtime/library").JsonValue;
        } | null;
        shopifyStoreUrl: string | null;
        status: import("@prisma/client").$Enums.AgentStatus;
        databaseProvider: string | null;
        twilioPhoneNumber: string | null;
        voiceId: string | null;
        id: string;
        slug: string;
        description: string | null;
        language: string;
        timezone: string | null;
        voice: string | null;
        voiceProvider: string | null;
        voiceStyle: string | null;
        baseSystemPrompt: string;
        greetingMessage: string | null;
        fallbackMessage: string | null;
        escalationMessage: string | null;
        model: string | null;
        temperature: number | null;
        isPublished: boolean;
        enabledTools: import("@prisma/client/runtime/library").JsonValue;
        maxToolCallsPerTurn: number | null;
        handoffEnabled: boolean;
        voiceResponseStyle: string | null;
        storeName: string | null;
        storeUrl: string | null;
        storeEmail: string | null;
        agentGoal: string | null;
        agentRole: string | null;
        toneOfVoice: string | null;
        allowedActions: string | null;
        restrictedActions: string | null;
        escalationInstructions: string | null;
        returnRefundBehavior: string | null;
        orderStatusHandling: string | null;
        outOfStockHandling: string | null;
        transferToHumanEnabled: boolean;
        escalationPhone: string | null;
        escalationEmail: string | null;
        shopifyStoreNumber: string | null;
        knowledgeBaseSource: string | null;
        knowledgeSyncEnabled: boolean;
        callRoutingMode: string | null;
        incomingCallHandling: string | null;
        shopifyConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        databaseConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        twilioConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        openaiConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        elevenlabsConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        lastConnectionTestAt: Date | null;
        createdById: string | null;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        clientId: string | null;
        storeId: string | null;
    }>;
    findAll(tenantId: string): Promise<{
        catalogReady: boolean;
        catalogLastSyncedAt: string | null;
        catalogItemCount: number;
    }[]>;
    getAnalytics(tenantId: string, id: string): Promise<{
        totalCalls: number;
        resolvedCalls: number;
        escalatedCalls: number;
        avgDurationSeconds: number | null;
        lastCallAt: string | null;
    }>;
    getLogs(tenantId: string, id: string, query: z.infer<typeof logsQuerySchema>): Promise<{
        id: string;
        fromNumber: string | null;
        toNumber: string | null;
        status: import("@prisma/client").$Enums.CallStatus;
        escalated: boolean;
        durationSeconds: number | null;
        createdAt: string;
        endedAt: string | null;
    }[]>;
    getCatalogReadiness(tenantId: string, id: string): Promise<{
        catalogReady: boolean;
        lastSyncedAt: string | null;
        itemCount: number;
        reason: string;
    }>;
    testAi(tenantId: string, id: string, dto: z.infer<typeof testAiBehaviorBodySchema>): Promise<{
        success: boolean;
        message: string;
        suggestedResponse?: string;
    }>;
    findOne(tenantId: string, id: string): Promise<{
        name: string;
        agentConfig: {
            supportEmail: string | null;
            supportPhone: string | null;
            businessName: string | null;
            askEmailBeforePaymentLink: boolean;
            checkoutMode: import("@prisma/client").$Enums.CheckoutMode;
            humanHandoffRules: string | null;
            shippingPolicy: string | null;
            returnPolicy: string | null;
            exchangePolicy: string | null;
            deliveryNotes: string | null;
            forbiddenBehaviors: string | null;
            escalationRules: string | null;
            fallbackHumanContact: string | null;
            customSystemPrompt: string | null;
        } | null;
        voiceProfile: {
            language: string;
            greetingMessage: string | null;
            provider: string;
            tone: string | null;
            providerConfig: import("@prisma/client/runtime/library").JsonValue;
        } | null;
        shopifyStoreUrl: string | null;
        status: import("@prisma/client").$Enums.AgentStatus;
        databaseProvider: string | null;
        twilioPhoneNumber: string | null;
        voiceId: string | null;
        id: string;
        slug: string;
        description: string | null;
        language: string;
        timezone: string | null;
        voice: string | null;
        voiceProvider: string | null;
        voiceStyle: string | null;
        baseSystemPrompt: string;
        greetingMessage: string | null;
        fallbackMessage: string | null;
        escalationMessage: string | null;
        model: string | null;
        temperature: number | null;
        isPublished: boolean;
        enabledTools: import("@prisma/client/runtime/library").JsonValue;
        maxToolCallsPerTurn: number | null;
        handoffEnabled: boolean;
        voiceResponseStyle: string | null;
        storeName: string | null;
        storeUrl: string | null;
        storeEmail: string | null;
        agentGoal: string | null;
        agentRole: string | null;
        toneOfVoice: string | null;
        allowedActions: string | null;
        restrictedActions: string | null;
        escalationInstructions: string | null;
        returnRefundBehavior: string | null;
        orderStatusHandling: string | null;
        outOfStockHandling: string | null;
        transferToHumanEnabled: boolean;
        escalationPhone: string | null;
        escalationEmail: string | null;
        shopifyStoreNumber: string | null;
        knowledgeBaseSource: string | null;
        knowledgeSyncEnabled: boolean;
        callRoutingMode: string | null;
        incomingCallHandling: string | null;
        shopifyConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        databaseConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        twilioConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        openaiConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        elevenlabsConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        lastConnectionTestAt: Date | null;
        createdById: string | null;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        clientId: string | null;
        storeId: string | null;
    }>;
    getReadiness(tenantId: string, id: string): Promise<{
        ready: boolean;
        status: string;
        checks: {
            key: string;
            label: string;
            pass: boolean;
            fixAction: string;
        }[];
        failures: {
            key: string;
            label: string;
            fixAction: string;
        }[];
        expectedTwilioWebhookUrls: {
            inbound: string;
            status: string;
            method: string;
        };
        observedTwilioWebhook: {
            voiceUrl: string | null;
            statusCallback: string | null;
            voiceMethod: string | null;
            statusCallbackMethod: string | null;
            sid: string;
        } | null;
    }>;
    configureTwilioWebhook(tenantId: string, id: string, _dto: z.infer<typeof configureTwilioWebhookBodySchema>): Promise<{
        ready: boolean;
        status: string;
        checks: {
            key: string;
            label: string;
            pass: boolean;
            fixAction: string;
        }[];
        failures: {
            key: string;
            label: string;
            fixAction: string;
        }[];
        expectedTwilioWebhookUrls: {
            inbound: string;
            status: string;
            method: string;
        };
        observedTwilioWebhook: {
            voiceUrl: string | null;
            statusCallback: string | null;
            voiceMethod: string | null;
            statusCallbackMethod: string | null;
            sid: string;
        } | null;
    }>;
    runSmokeTest(tenantId: string, id: string, dto: z.infer<typeof smokeTestBodySchema>): Promise<{
        ok: boolean;
        checks: {
            key: string;
            pass: boolean;
            details: string;
        }[];
        note: string;
    }>;
    goLive(tenantId: string, userId: string, id: string): Promise<{
        status: string;
        ready: boolean;
        failures: {
            key: string;
            label: string;
            fixAction: string;
        }[];
        readiness: {
            ready: boolean;
            status: string;
            checks: {
                key: string;
                label: string;
                pass: boolean;
                fixAction: string;
            }[];
            failures: {
                key: string;
                label: string;
                fixAction: string;
            }[];
            expectedTwilioWebhookUrls: {
                inbound: string;
                status: string;
                method: string;
            };
            observedTwilioWebhook: {
                voiceUrl: string | null;
                statusCallback: string | null;
                voiceMethod: string | null;
                statusCallbackMethod: string | null;
                sid: string;
            } | null;
        };
    } | {
        status: string;
        ready: boolean;
        readiness: {
            ready: boolean;
            status: string;
            checks: {
                key: string;
                label: string;
                pass: boolean;
                fixAction: string;
            }[];
            failures: {
                key: string;
                label: string;
                fixAction: string;
            }[];
            expectedTwilioWebhookUrls: {
                inbound: string;
                status: string;
                method: string;
            };
            observedTwilioWebhook: {
                voiceUrl: string | null;
                statusCallback: string | null;
                voiceMethod: string | null;
                statusCallbackMethod: string | null;
                sid: string;
            } | null;
        };
        failures?: undefined;
    }>;
    syncSecretsFromSettings(tenantId: string, userId: string, id: string): Promise<{
        updatedSecrets: Record<"shopifyAdminToken" | "databaseUrl" | "databaseAccessToken" | "twilioAccountSid" | "twilioAuthToken" | "openaiApiKey" | "elevenlabsApiKey" | "shopifyApiKey" | "shopifyApiSecret" | "webhookSecret", boolean>;
        name: string;
        agentConfig: {
            supportEmail: string | null;
            supportPhone: string | null;
            businessName: string | null;
            askEmailBeforePaymentLink: boolean;
            checkoutMode: import("@prisma/client").$Enums.CheckoutMode;
            humanHandoffRules: string | null;
            shippingPolicy: string | null;
            returnPolicy: string | null;
            exchangePolicy: string | null;
            deliveryNotes: string | null;
            forbiddenBehaviors: string | null;
            escalationRules: string | null;
            fallbackHumanContact: string | null;
            customSystemPrompt: string | null;
        } | null;
        voiceProfile: {
            language: string;
            greetingMessage: string | null;
            provider: string;
            tone: string | null;
            providerConfig: import("@prisma/client/runtime/library").JsonValue;
        } | null;
        shopifyStoreUrl: string | null;
        status: import("@prisma/client").$Enums.AgentStatus;
        databaseProvider: string | null;
        twilioPhoneNumber: string | null;
        voiceId: string | null;
        id: string;
        slug: string;
        description: string | null;
        language: string;
        timezone: string | null;
        voice: string | null;
        voiceProvider: string | null;
        voiceStyle: string | null;
        baseSystemPrompt: string;
        greetingMessage: string | null;
        fallbackMessage: string | null;
        escalationMessage: string | null;
        model: string | null;
        temperature: number | null;
        isPublished: boolean;
        enabledTools: import("@prisma/client/runtime/library").JsonValue;
        maxToolCallsPerTurn: number | null;
        handoffEnabled: boolean;
        voiceResponseStyle: string | null;
        storeName: string | null;
        storeUrl: string | null;
        storeEmail: string | null;
        agentGoal: string | null;
        agentRole: string | null;
        toneOfVoice: string | null;
        allowedActions: string | null;
        restrictedActions: string | null;
        escalationInstructions: string | null;
        returnRefundBehavior: string | null;
        orderStatusHandling: string | null;
        outOfStockHandling: string | null;
        transferToHumanEnabled: boolean;
        escalationPhone: string | null;
        escalationEmail: string | null;
        shopifyStoreNumber: string | null;
        knowledgeBaseSource: string | null;
        knowledgeSyncEnabled: boolean;
        callRoutingMode: string | null;
        incomingCallHandling: string | null;
        shopifyConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        databaseConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        twilioConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        openaiConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        elevenlabsConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        lastConnectionTestAt: Date | null;
        createdById: string | null;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        clientId: string | null;
        storeId: string | null;
    }>;
    update(tenantId: string, userId: string, id: string, dto: UpdateAgentDto): Promise<{
        updatedSecrets: Record<"shopifyAdminToken" | "databaseUrl" | "databaseAccessToken" | "twilioAccountSid" | "twilioAuthToken" | "openaiApiKey" | "elevenlabsApiKey" | "shopifyApiKey" | "shopifyApiSecret" | "webhookSecret", boolean>;
        name: string;
        agentConfig: {
            supportEmail: string | null;
            supportPhone: string | null;
            businessName: string | null;
            askEmailBeforePaymentLink: boolean;
            checkoutMode: import("@prisma/client").$Enums.CheckoutMode;
            humanHandoffRules: string | null;
            shippingPolicy: string | null;
            returnPolicy: string | null;
            exchangePolicy: string | null;
            deliveryNotes: string | null;
            forbiddenBehaviors: string | null;
            escalationRules: string | null;
            fallbackHumanContact: string | null;
            customSystemPrompt: string | null;
        } | null;
        voiceProfile: {
            language: string;
            greetingMessage: string | null;
            provider: string;
            tone: string | null;
            providerConfig: import("@prisma/client/runtime/library").JsonValue;
        } | null;
        shopifyStoreUrl: string | null;
        status: import("@prisma/client").$Enums.AgentStatus;
        databaseProvider: string | null;
        twilioPhoneNumber: string | null;
        voiceId: string | null;
        id: string;
        slug: string;
        description: string | null;
        language: string;
        timezone: string | null;
        voice: string | null;
        voiceProvider: string | null;
        voiceStyle: string | null;
        baseSystemPrompt: string;
        greetingMessage: string | null;
        fallbackMessage: string | null;
        escalationMessage: string | null;
        model: string | null;
        temperature: number | null;
        isPublished: boolean;
        enabledTools: import("@prisma/client/runtime/library").JsonValue;
        maxToolCallsPerTurn: number | null;
        handoffEnabled: boolean;
        voiceResponseStyle: string | null;
        storeName: string | null;
        storeUrl: string | null;
        storeEmail: string | null;
        agentGoal: string | null;
        agentRole: string | null;
        toneOfVoice: string | null;
        allowedActions: string | null;
        restrictedActions: string | null;
        escalationInstructions: string | null;
        returnRefundBehavior: string | null;
        orderStatusHandling: string | null;
        outOfStockHandling: string | null;
        transferToHumanEnabled: boolean;
        escalationPhone: string | null;
        escalationEmail: string | null;
        shopifyStoreNumber: string | null;
        knowledgeBaseSource: string | null;
        knowledgeSyncEnabled: boolean;
        callRoutingMode: string | null;
        incomingCallHandling: string | null;
        shopifyConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        databaseConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        twilioConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        openaiConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        elevenlabsConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        lastConnectionTestAt: Date | null;
        createdById: string | null;
        createdAt: Date;
        updatedAt: Date;
        tenantId: string;
        clientId: string | null;
        storeId: string | null;
    }>;
    remove(tenantId: string, userId: string, id: string): Promise<{
        deleted: boolean;
    }>;
    testShopify(tenantId: string, id: string, dto: z.infer<typeof testShopifyCredentialsSchema>): Promise<{
        success: boolean;
        message: string;
        status?: import("@prisma/client").ConnectionStatus;
        provider: "shopify";
        source: "agent" | "workspace" | "env" | "missing";
    } | {
        success: boolean;
        message: string;
        code: string;
    }>;
    testDatabase(tenantId: string, id: string, dto: z.infer<typeof testDatabaseCredentialsSchema>): Promise<{
        success: boolean;
        message: string;
        status?: import("@prisma/client").ConnectionStatus;
    }>;
    testTwilio(tenantId: string, id: string, dto: z.infer<typeof testTwilioCredentialsSchema>): Promise<{
        success: boolean;
        message: string;
        status?: import("@prisma/client").ConnectionStatus;
        provider: "twilio";
        source: "agent" | "workspace" | "env" | "missing";
    }>;
    testOpenAI(tenantId: string, id: string, dto: z.infer<typeof testOpenAiCredentialsSchema>): Promise<{
        success: boolean;
        message: string;
        status?: import("@prisma/client").ConnectionStatus;
        provider: "openai";
        source: "agent" | "workspace" | "env" | "missing";
        warnings?: string[];
    }>;
    testElevenLabs(tenantId: string, id: string, dto: z.infer<typeof testElevenLabsCredentialsSchema>): Promise<{
        success: boolean;
        message: string;
        status?: import("@prisma/client").ConnectionStatus;
        provider: "elevenlabs";
        source: "agent" | "workspace" | "env" | "missing";
        warnings?: string[];
    }>;
    debugShopifySearch(tenantId: string, id: string, dto: z.infer<typeof debugShopifySearchBodySchema>): Promise<{
        cleanedQuery: string;
        probableTitle: string;
        shopifyQueriesTried: Array<{
            label: string;
            query: string;
        }>;
        productsReturned: number;
        productsAfterRanking: number;
        topProduct: string | null;
        rawShopifyProductTitles: string[];
        rankedProducts: Array<{
            title: string;
            score: number;
            matchReason: string;
        }>;
        topScore: number | null;
        topMatchReason: string | null;
        selectedProduct: import("./shopify-agent.service").ShopifyProductSummary | null;
        selectionExplanation: string;
    }>;
}
