import { AgentsService } from './agents.service';
import { ShopifyAgentService } from './shopify-agent.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { logsQuerySchema, testAiBehaviorBodySchema, testDatabaseCredentialsSchema, testElevenLabsCredentialsSchema, testOpenAiCredentialsSchema, testShopifyCredentialsSchema, testTwilioCredentialsSchema, configureTwilioWebhookBodySchema, smokeTestBodySchema, debugShopifySearchBodySchema, testAgentEmailBodySchema, updateAgentStatusBodySchema } from './agents-validation';
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
        source: import("../../common/credential-priority.util").CredentialSource;
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
        source: import("../../common/credential-priority.util").CredentialSource;
    } | {
        success: boolean;
        message: string;
    }>;
    testOpenAICredentials(tenantId: string, dto: z.infer<typeof testOpenAiCredentialsSchema>): Promise<{
        success: boolean;
        message: string;
        status?: import("@prisma/client").ConnectionStatus;
        provider: "openai";
        source: import("../../common/credential-priority.util").CredentialSource;
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
        source: import("../../common/credential-priority.util").CredentialSource;
        warnings?: string[];
    } | {
        success: boolean;
        message: string;
    }>;
    create(tenantId: string, userId: string, dto: CreateAgentDto): Promise<{
        twilioPhoneNumber: string | null;
        agentConfig: {
            checkoutMode: import("@prisma/client").$Enums.CheckoutMode;
            supportEmail: string | null;
            supportPhone: string | null;
            businessName: string | null;
            askEmailBeforePaymentLink: boolean;
            humanHandoffRules: string | null;
            shippingPolicy: string | null;
            returnPolicy: string | null;
            exchangePolicy: string | null;
            deliveryNotes: string | null;
            forbiddenBehaviors: string | null;
            escalationRules: string | null;
            fallbackHumanContact: string | null;
            customSystemPrompt: string | null;
            emailSenderName: string | null;
            emailSenderAddress: string | null;
            emailReplyTo: string | null;
            emailSubjectTemplate: string | null;
            paymentLinkEmailIntro: string | null;
            emailTestRecipient: string | null;
            useWorkspaceEmail: boolean;
            useWorkspaceShopify: boolean;
            useWorkspaceOpenai: boolean;
            useWorkspaceElevenlabs: boolean;
            useWorkspaceTwilio: boolean;
            shopifyApiVersion: string | null;
        } | null;
        voiceProfile: {
            language: string;
            greetingMessage: string | null;
            provider: string;
            tone: string | null;
            providerConfig: import("@prisma/client/runtime/client").JsonValue;
        } | null;
        id: string;
        tenantId: string;
        name: string;
        slug: string;
        timezone: string | null;
        status: import("@prisma/client").$Enums.AgentStatus;
        createdAt: Date;
        updatedAt: Date;
        clientId: string | null;
        storeId: string | null;
        description: string | null;
        language: string;
        voice: string | null;
        voiceProvider: string | null;
        voiceId: string | null;
        voiceNameLabel: string | null;
        voiceStyle: string | null;
        baseSystemPrompt: string;
        greetingMessage: string | null;
        fallbackMessage: string | null;
        escalationMessage: string | null;
        model: string | null;
        temperature: number | null;
        isPublished: boolean;
        enabledTools: import("@prisma/client/runtime/client").JsonValue;
        toolPermissions: import("@prisma/client/runtime/client").JsonValue;
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
        shopifyStoreUrl: string | null;
        shopifyStoreNumber: string | null;
        knowledgeBaseSource: string | null;
        knowledgeSyncEnabled: boolean;
        callRoutingMode: string | null;
        incomingCallHandling: string | null;
        databaseProvider: string | null;
        shopifyConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        databaseConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        twilioConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        openaiConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        elevenlabsConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        lastConnectionTestAt: Date | null;
        createdById: string | null;
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
        shopifySource: "agent" | "env" | "workspace" | "missing";
        shopifyConfigured: boolean;
    }>;
    testAi(tenantId: string, id: string, dto: z.infer<typeof testAiBehaviorBodySchema>): Promise<{
        success: boolean;
        message: string;
        suggestedResponse?: string;
        source?: import("../../common/credential-priority.util").CredentialSource;
    }>;
    getRuntimePromptPreview(tenantId: string, id: string): Promise<{
        agentId: string;
        agentName: string;
        updatedAt: string;
        greetingMessage: string | null;
        prompt: string;
        promptLength: number;
        promptBudget: import("../calls/runtime/prompt-budget.util").PromptBudgetReport;
        promptLayers: {
            platform: string;
            agentIdentity: string;
            storePolicyKnowledge: string;
            runtimeTools: string;
            shopifyTruth: string;
            knowledgeRetrieval: string;
            runtimeContext: string;
        };
    }>;
    findOne(tenantId: string, id: string): Promise<{
        agentConfig: {
            resendApiKeyConfigured: boolean;
            checkoutMode: import("@prisma/client").$Enums.CheckoutMode;
            supportEmail: string | null;
            supportPhone: string | null;
            businessName: string | null;
            askEmailBeforePaymentLink: boolean;
            humanHandoffRules: string | null;
            shippingPolicy: string | null;
            returnPolicy: string | null;
            exchangePolicy: string | null;
            deliveryNotes: string | null;
            forbiddenBehaviors: string | null;
            escalationRules: string | null;
            fallbackHumanContact: string | null;
            customSystemPrompt: string | null;
            emailSenderName: string | null;
            emailSenderAddress: string | null;
            emailReplyTo: string | null;
            emailSubjectTemplate: string | null;
            paymentLinkEmailIntro: string | null;
            emailTestRecipient: string | null;
            useWorkspaceEmail: boolean;
            useWorkspaceShopify: boolean;
            useWorkspaceOpenai: boolean;
            useWorkspaceElevenlabs: boolean;
            useWorkspaceTwilio: boolean;
            shopifyApiVersion: string | null;
        } | null;
        shopifyConfigured: boolean;
        shopifySource: import("../../common/credential-priority.util").CredentialSource;
        credentialSources: import("../../common/credential-resolver.util").CredentialSourcesSummary;
        twilioPhoneNumber: string | null;
        voiceProfile: {
            language: string;
            greetingMessage: string | null;
            provider: string;
            tone: string | null;
            providerConfig: import("@prisma/client/runtime/client").JsonValue;
        } | null;
        id: string;
        tenantId: string;
        name: string;
        slug: string;
        timezone: string | null;
        status: import("@prisma/client").$Enums.AgentStatus;
        createdAt: Date;
        updatedAt: Date;
        clientId: string | null;
        storeId: string | null;
        description: string | null;
        language: string;
        voice: string | null;
        voiceProvider: string | null;
        voiceId: string | null;
        voiceNameLabel: string | null;
        voiceStyle: string | null;
        baseSystemPrompt: string;
        greetingMessage: string | null;
        fallbackMessage: string | null;
        escalationMessage: string | null;
        model: string | null;
        temperature: number | null;
        isPublished: boolean;
        enabledTools: import("@prisma/client/runtime/client").JsonValue;
        toolPermissions: import("@prisma/client/runtime/client").JsonValue;
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
        shopifyStoreUrl: string | null;
        shopifyStoreNumber: string | null;
        knowledgeBaseSource: string | null;
        knowledgeSyncEnabled: boolean;
        callRoutingMode: string | null;
        incomingCallHandling: string | null;
        databaseProvider: string | null;
        shopifyConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        databaseConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        twilioConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        openaiConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        elevenlabsConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        lastConnectionTestAt: Date | null;
        createdById: string | null;
    }>;
    getRuntimeDebug(tenantId: string, id: string, callSessionId?: string): Promise<{
        agentId: string;
        toolsEnabled: string[];
        toolPermissions: import("@bookstore-voice-agents/types").AgentToolPermissions;
        personality: import("@bookstore-voice-agents/types").VoicePersonalityTraits | null;
        livePromptPreview: string;
        promptBudget: import("../calls/runtime/prompt-budget.util").PromptBudgetReport;
        promptLayers: {
            platform: string;
            agentIdentity: string;
            storePolicyKnowledge: string;
            runtimeTools: string;
            shopifyTruth: string;
            knowledgeRetrieval: string;
            runtimeContext: string;
        };
        activeRestrictions: {
            blockedTopics: string | null;
            allowedTopics: string | null;
            forbiddenBehaviors: string | null;
        };
        lastToolCalls: Record<string, unknown>[];
        runtimeContextPreview: Record<string, unknown> | null;
        credentialSources: import("../../common/credential-resolver.util").CredentialSourcesSummary;
        liveMonitor: Record<string, unknown> | null;
        toolCatalog: {
            name: string;
            permissionGroups: (keyof import("@bookstore-voice-agents/types").AgentToolPermissions)[];
        }[];
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
        credentialSources: import("../../common/credential-resolver.util").CredentialSourcesSummary;
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
    sendTestEmail(tenantId: string, id: string, body: z.infer<typeof testAgentEmailBodySchema>): Promise<{
        success: boolean;
        message: string;
        emailEventId?: string;
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
        credentialSources: import("../../common/credential-resolver.util").CredentialSourcesSummary;
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
            credentialSources: import("../../common/credential-resolver.util").CredentialSourcesSummary;
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
            credentialSources: import("../../common/credential-resolver.util").CredentialSourcesSummary;
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
        updatedSecrets: Record<"twilioAccountSid" | "openaiApiKey" | "twilioAuthToken" | "shopifyAdminToken" | "databaseUrl" | "databaseAccessToken" | "elevenlabsApiKey" | "shopifyApiKey" | "shopifyApiSecret" | "webhookSecret" | "resendApiKey", boolean>;
        twilioPhoneNumber: string | null;
        agentConfig: {
            checkoutMode: import("@prisma/client").$Enums.CheckoutMode;
            supportEmail: string | null;
            supportPhone: string | null;
            businessName: string | null;
            askEmailBeforePaymentLink: boolean;
            humanHandoffRules: string | null;
            shippingPolicy: string | null;
            returnPolicy: string | null;
            exchangePolicy: string | null;
            deliveryNotes: string | null;
            forbiddenBehaviors: string | null;
            escalationRules: string | null;
            fallbackHumanContact: string | null;
            customSystemPrompt: string | null;
            emailSenderName: string | null;
            emailSenderAddress: string | null;
            emailReplyTo: string | null;
            emailSubjectTemplate: string | null;
            paymentLinkEmailIntro: string | null;
            emailTestRecipient: string | null;
            useWorkspaceEmail: boolean;
            useWorkspaceShopify: boolean;
            useWorkspaceOpenai: boolean;
            useWorkspaceElevenlabs: boolean;
            useWorkspaceTwilio: boolean;
            shopifyApiVersion: string | null;
        } | null;
        voiceProfile: {
            language: string;
            greetingMessage: string | null;
            provider: string;
            tone: string | null;
            providerConfig: import("@prisma/client/runtime/client").JsonValue;
        } | null;
        id: string;
        tenantId: string;
        name: string;
        slug: string;
        timezone: string | null;
        status: import("@prisma/client").$Enums.AgentStatus;
        createdAt: Date;
        updatedAt: Date;
        clientId: string | null;
        storeId: string | null;
        description: string | null;
        language: string;
        voice: string | null;
        voiceProvider: string | null;
        voiceId: string | null;
        voiceNameLabel: string | null;
        voiceStyle: string | null;
        baseSystemPrompt: string;
        greetingMessage: string | null;
        fallbackMessage: string | null;
        escalationMessage: string | null;
        model: string | null;
        temperature: number | null;
        isPublished: boolean;
        enabledTools: import("@prisma/client/runtime/client").JsonValue;
        toolPermissions: import("@prisma/client/runtime/client").JsonValue;
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
        shopifyStoreUrl: string | null;
        shopifyStoreNumber: string | null;
        knowledgeBaseSource: string | null;
        knowledgeSyncEnabled: boolean;
        callRoutingMode: string | null;
        incomingCallHandling: string | null;
        databaseProvider: string | null;
        shopifyConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        databaseConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        twilioConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        openaiConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        elevenlabsConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        lastConnectionTestAt: Date | null;
        createdById: string | null;
    }>;
    updateStatus(tenantId: string, userId: string, id: string, body: z.infer<typeof updateAgentStatusBodySchema>): Promise<{
        agent: Record<string, unknown>;
        ready: boolean;
        goLiveStatus: string;
        failures: {
            key: string;
            label: string;
            fixAction: string;
        }[] | undefined;
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
            credentialSources: import("../../common/credential-resolver.util").CredentialSourcesSummary;
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
        agent: Record<string, unknown>;
        ready: boolean;
        goLiveStatus?: undefined;
        failures?: undefined;
        readiness?: undefined;
    }>;
    update(tenantId: string, userId: string, id: string, dto: UpdateAgentDto): Promise<{
        updatedSecrets: Record<"twilioAccountSid" | "openaiApiKey" | "twilioAuthToken" | "shopifyAdminToken" | "databaseUrl" | "databaseAccessToken" | "elevenlabsApiKey" | "shopifyApiKey" | "shopifyApiSecret" | "webhookSecret" | "resendApiKey", boolean>;
        twilioPhoneNumber: string | null;
        agentConfig: {
            checkoutMode: import("@prisma/client").$Enums.CheckoutMode;
            supportEmail: string | null;
            supportPhone: string | null;
            businessName: string | null;
            askEmailBeforePaymentLink: boolean;
            humanHandoffRules: string | null;
            shippingPolicy: string | null;
            returnPolicy: string | null;
            exchangePolicy: string | null;
            deliveryNotes: string | null;
            forbiddenBehaviors: string | null;
            escalationRules: string | null;
            fallbackHumanContact: string | null;
            customSystemPrompt: string | null;
            emailSenderName: string | null;
            emailSenderAddress: string | null;
            emailReplyTo: string | null;
            emailSubjectTemplate: string | null;
            paymentLinkEmailIntro: string | null;
            emailTestRecipient: string | null;
            useWorkspaceEmail: boolean;
            useWorkspaceShopify: boolean;
            useWorkspaceOpenai: boolean;
            useWorkspaceElevenlabs: boolean;
            useWorkspaceTwilio: boolean;
            shopifyApiVersion: string | null;
        } | null;
        voiceProfile: {
            language: string;
            greetingMessage: string | null;
            provider: string;
            tone: string | null;
            providerConfig: import("@prisma/client/runtime/client").JsonValue;
        } | null;
        id: string;
        tenantId: string;
        name: string;
        slug: string;
        timezone: string | null;
        status: import("@prisma/client").$Enums.AgentStatus;
        createdAt: Date;
        updatedAt: Date;
        clientId: string | null;
        storeId: string | null;
        description: string | null;
        language: string;
        voice: string | null;
        voiceProvider: string | null;
        voiceId: string | null;
        voiceNameLabel: string | null;
        voiceStyle: string | null;
        baseSystemPrompt: string;
        greetingMessage: string | null;
        fallbackMessage: string | null;
        escalationMessage: string | null;
        model: string | null;
        temperature: number | null;
        isPublished: boolean;
        enabledTools: import("@prisma/client/runtime/client").JsonValue;
        toolPermissions: import("@prisma/client/runtime/client").JsonValue;
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
        shopifyStoreUrl: string | null;
        shopifyStoreNumber: string | null;
        knowledgeBaseSource: string | null;
        knowledgeSyncEnabled: boolean;
        callRoutingMode: string | null;
        incomingCallHandling: string | null;
        databaseProvider: string | null;
        shopifyConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        databaseConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        twilioConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        openaiConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        elevenlabsConnectionStatus: import("@prisma/client").$Enums.ConnectionStatus;
        lastConnectionTestAt: Date | null;
        createdById: string | null;
    }>;
    remove(tenantId: string, userId: string, id: string): Promise<{
        deleted: boolean;
    }>;
    testShopify(tenantId: string, id: string, dto: z.infer<typeof testShopifyCredentialsSchema>): Promise<{
        success: boolean;
        message: string;
        status?: import("@prisma/client").ConnectionStatus;
        provider: "shopify";
        source: import("../../common/credential-priority.util").CredentialSource;
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
        source: import("../../common/credential-priority.util").CredentialSource;
    }>;
    testOpenAI(tenantId: string, id: string, dto: z.infer<typeof testOpenAiCredentialsSchema>): Promise<{
        success: boolean;
        message: string;
        status?: import("@prisma/client").ConnectionStatus;
        provider: "openai";
        source: import("../../common/credential-priority.util").CredentialSource;
        warnings?: string[];
    }>;
    testElevenLabs(tenantId: string, id: string, dto: z.infer<typeof testElevenLabsCredentialsSchema>): Promise<{
        success: boolean;
        message: string;
        status?: import("@prisma/client").ConnectionStatus;
        provider: "elevenlabs";
        source: import("../../common/credential-priority.util").CredentialSource;
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
