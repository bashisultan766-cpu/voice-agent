import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { EncryptionService } from '../../common/encryption.service';
import { ShopifyConnectionTestService } from '../agents/connection-test/shopify-connection-test.service';
import { TwilioConnectionTestService } from '../agents/connection-test/twilio-connection-test.service';
import { OpenAIConnectionTestService } from '../agents/connection-test/openai-connection-test.service';
import { ElevenLabsConnectionTestService } from '../agents/connection-test/elevenlabs-connection-test.service';
export declare class TenantIntegrationsService {
    private readonly prisma;
    private readonly encryption;
    private readonly config;
    private readonly shopifyTest;
    private readonly twilioTest;
    private readonly openaiTest;
    private readonly elevenlabsTest;
    private readonly log;
    private isSchemaDriftError;
    private buildSchemaDriftMessage;
    private mapIntegrationError;
    constructor(prisma: PrismaService, encryption: EncryptionService, config: ConfigService, shopifyTest: ShopifyConnectionTestService, twilioTest: TwilioConnectionTestService, openaiTest: OpenAIConnectionTestService, elevenlabsTest: ElevenLabsConnectionTestService);
    private audit;
    private getTenantIntegrationRowResilient;
    getSafeSummary(tenantId: string): Promise<{
        shopify: {
            configured: boolean;
            shopDomain: string | null;
            tokenMasked: string | null;
            lastTestOk: boolean | null;
            lastTestAt: string | null;
        };
        twilio: {
            configured: boolean;
            accountSidLast4: string | null;
            authTokenMasked: string | null;
            phoneNumber: string | null;
            lastTestOk: boolean | null;
            lastTestAt: string | null;
        };
        openai: {
            configured: boolean;
            keyMasked: string | null;
            lastTestOk: boolean | null;
            lastTestAt: string | null;
        };
        elevenlabs: {
            configured: boolean;
            keyMasked: string | null;
            defaultVoiceId: string | null;
            defaultModel: string | null;
            lastTestOk: boolean | null;
            lastTestAt: string | null;
        };
        email: {
            configured: boolean;
            fromEmail: string | null;
            keyMasked: string | null;
            lastTestOk: boolean | null;
            lastTestAt: string | null;
        };
    }>;
    testShopify(tenantId: string, body: {
        shopDomain: string;
        accessToken?: string;
    }): Promise<{
        success: boolean;
        message: string;
        warnings: string[] | undefined;
    }>;
    saveShopify(tenantId: string, body: {
        shopDomain: string;
        accessToken?: string;
        skipConnectionTest?: boolean;
    }): Promise<{
        ok: boolean;
        storeId: string;
        shopDomain: string;
    }>;
    testTwilio(tenantId: string, body: {
        accountSid: string;
        authToken?: string;
        phoneNumber?: string;
    }): Promise<{
        success: boolean;
        message: string;
    }>;
    saveTwilio(tenantId: string, body: {
        accountSid: string;
        authToken?: string;
        phoneNumber: string;
        skipConnectionTest?: boolean;
    }): Promise<{
        ok: boolean;
        saved: boolean;
        phoneNumber: string;
        authTokenMasked: string;
    }>;
    configureTwilioWebhook(tenantId: string): Promise<{
        success: boolean;
        message: string;
        webhook: {
            inboundUrl: string;
            statusUrl: string;
            method: "POST";
        };
        mediaStream: {
            enabled: boolean;
            wsUrl: null;
        };
    }>;
    testOpenai(tenantId: string, body: {
        apiKey?: string;
    }): Promise<{
        success: boolean;
        message: string;
        warnings: string[] | undefined;
    }>;
    saveOpenai(tenantId: string, body: {
        apiKey?: string;
        skipConnectionTest?: boolean;
    }): Promise<{
        ok: boolean;
        keyPresent: boolean;
    }>;
    testElevenlabs(tenantId: string, body: {
        apiKey?: string;
        voiceId?: string;
        model?: string;
    }): Promise<{
        success: boolean;
        message: string;
        warnings: string[] | undefined;
    }>;
    saveElevenlabs(tenantId: string, body: {
        apiKey?: string;
        defaultVoiceId?: string;
        defaultModel?: string;
        skipConnectionTest?: boolean;
    }): Promise<{
        ok: boolean;
        keyPresent: boolean;
    }>;
    testEmail(tenantId: string, body: {
        apiKey?: string;
        fromEmail: string;
        testRecipientEmail: string;
        fromName?: string;
    }): Promise<{
        success: boolean;
        message: string;
    }>;
    private resolveResendApiKeyForTest;
    private recordEmailTestResult;
    saveEmail(tenantId: string, body: {
        apiKey?: string;
        fromEmail: string;
    }): Promise<{
        ok: boolean;
    }>;
}
