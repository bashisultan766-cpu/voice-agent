import { TenantIntegrationsService } from './tenant-integrations.service';
declare class ShopifyTestBodyDto {
    shopDomain: string;
    accessToken?: string;
}
declare class ShopifySaveBodyDto {
    shopDomain: string;
    accessToken?: string;
    skipConnectionTest?: boolean;
}
declare class TwilioBodyDto {
    accountSid: string;
    authToken: string;
    phoneNumber: string;
    skipConnectionTest?: boolean;
}
declare class TwilioTestBodyDto {
    accountSid: string;
    authToken: string;
    phoneNumber?: string;
}
declare class OpenaiTestBodyDto {
    apiKey?: string;
}
declare class OpenaiSaveBodyDto {
    apiKey?: string;
    skipConnectionTest?: boolean;
}
declare class ElevenlabsTestBodyDto {
    apiKey?: string;
    voiceId?: string;
    model?: string;
}
declare class ElevenlabsSaveBodyDto extends ElevenlabsTestBodyDto {
    defaultVoiceId?: string;
    defaultModel?: string;
    skipConnectionTest?: boolean;
}
declare class EmailTestBodyDto {
    apiKey: string;
    fromEmail: string;
}
declare class EmailSaveBodyDto {
    apiKey?: string;
    fromEmail: string;
    skipConnectionTest?: boolean;
}
export declare class TenantIntegrationsController {
    private readonly svc;
    constructor(svc: TenantIntegrationsService);
    summary(tenantId: string): Promise<{
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
    testShopify(tenantId: string, body: ShopifyTestBodyDto): Promise<{
        success: boolean;
        message: string;
        warnings: string[] | undefined;
    }>;
    saveShopify(tenantId: string, body: ShopifySaveBodyDto): Promise<{
        ok: boolean;
        storeId: string;
        shopDomain: string;
    }>;
    testTwilio(tenantId: string, body: TwilioTestBodyDto): Promise<{
        success: boolean;
        message: string;
    }>;
    saveTwilio(tenantId: string, body: TwilioBodyDto): Promise<{
        ok: boolean;
    }>;
    testOpenai(tenantId: string, body: OpenaiTestBodyDto): Promise<{
        success: boolean;
        message: string;
        warnings: string[] | undefined;
    }>;
    testOpenaiSaved(tenantId: string): Promise<{
        success: boolean;
        message: string;
        warnings: string[] | undefined;
    }>;
    saveOpenai(tenantId: string, body: OpenaiSaveBodyDto): Promise<{
        ok: boolean;
        keyPresent: boolean;
    }>;
    testElevenlabs(tenantId: string, body: ElevenlabsTestBodyDto): Promise<{
        success: boolean;
        message: string;
        warnings: string[] | undefined;
    }>;
    saveElevenlabs(tenantId: string, body: ElevenlabsSaveBodyDto): Promise<{
        ok: boolean;
        keyPresent: boolean;
    }>;
    testEmail(tenantId: string, body: EmailTestBodyDto): Promise<{
        success: boolean;
        message: string;
    }>;
    saveEmail(tenantId: string, body: EmailSaveBodyDto): Promise<{
        ok: boolean;
    }>;
}
export {};
