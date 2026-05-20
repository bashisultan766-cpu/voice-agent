import type { VoiceAgentRuntimeConfig } from '@bookstore-voice-agents/types';
import { PrismaService } from '../../../database/prisma.service';
import { EncryptionService } from '../../../common/encryption.service';
import { type VoiceCredentialSource } from './voice-config-resolution.util';
export interface VoiceSessionContext {
    callSessionId: string;
    tenantId: string;
    storeId: string | null;
    agentId: string;
    phoneNumberId?: string | null;
    fromNumber?: string | null;
    toNumber?: string | null;
    agent: {
        name: string;
        voice?: string | null;
        voiceProvider?: string | null;
        voiceId?: string | null;
        voiceStyle?: string | null;
        language: string;
        baseSystemPrompt: string;
        agentGoal?: string | null;
        agentRole?: string | null;
        toneOfVoice?: string | null;
        allowedActions?: string | null;
        restrictedActions?: string | null;
        escalationInstructions?: string | null;
        returnRefundBehavior?: string | null;
        orderStatusHandling?: string | null;
        outOfStockHandling?: string | null;
        transferToHumanEnabled?: boolean | null;
        escalationPhone?: string | null;
        escalationEmail?: string | null;
        greetingMessage?: string | null;
        fallbackMessage?: string | null;
        escalationMessage?: string | null;
        model?: string | null;
        temperature?: number | null;
        enabledTools?: string[] | null;
        maxToolCallsPerTurn?: number | null;
        handoffEnabled?: boolean | null;
        knowledgeBaseSource?: string | null;
        knowledgeSyncEnabled?: boolean | null;
        callRoutingMode?: string | null;
        incomingCallHandling?: string | null;
        openaiApiKey?: string | null;
        elevenlabsApiKey?: string | null;
        elevenlabsModel?: string | null;
        languageMode?: 'auto' | 'fixed' | null;
        fixedLanguage?: string | null;
        supportedLanguages?: string[] | null;
        config?: VoiceAgentRuntimeConfig | null;
        shopify?: {
            storeUrl?: string | null;
            shopDomain?: string | null;
            shopifyConnectionId?: string | null;
            hasAdminToken?: boolean;
            connectionStatus?: string | null;
        } | null;
        runtimeCredentialHints?: {
            openaiKeySource: VoiceCredentialSource;
            elevenLabsKeySource: VoiceCredentialSource;
        };
    };
    configUpdatedAt?: string | null;
    store: {
        name: string;
        city?: string | null;
        timezone?: string | null;
    };
    metadata?: Record<string, unknown>;
}
export declare class SessionContextService {
    private readonly prisma;
    private readonly encryption;
    private readonly log;
    constructor(prisma: PrismaService, encryption: EncryptionService);
    load(callSessionId: string): Promise<VoiceSessionContext | null>;
}
