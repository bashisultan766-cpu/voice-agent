import type { ConnectionTestResult } from './connection-test.types';
export interface TwilioTestConfig {
    twilioAccountSid?: string | null;
    twilioAuthToken?: string | null;
    twilioPhoneNumber?: string | null;
}
export interface TwilioIncomingPhoneConfig {
    sid: string;
    accountSid: string;
    phoneNumber: string;
    voiceUrl: string | null;
    voiceMethod: string | null;
    statusCallback: string | null;
    statusCallbackMethod: string | null;
}
export declare class TwilioConnectionTestService {
    private authHeader;
    private apiBase;
    validateRequired(config: TwilioTestConfig): string | null;
    testConnection(config: TwilioTestConfig): Promise<ConnectionTestResult>;
    resolveIncomingPhoneSid(config: TwilioTestConfig): Promise<string | null>;
    getIncomingPhoneNumberConfig(config: TwilioTestConfig): Promise<TwilioIncomingPhoneConfig | null>;
    updateIncomingPhoneNumberWebhook(config: TwilioTestConfig, opts: {
        incomingPhoneSid: string;
        voiceUrl: string;
        statusCallback: string;
        method?: 'POST' | 'GET';
    }): Promise<{
        success: boolean;
        message: string;
    }>;
}
