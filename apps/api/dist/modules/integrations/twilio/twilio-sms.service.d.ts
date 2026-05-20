import { ConfigService } from '@nestjs/config';
export declare class TwilioSmsService {
    private readonly config;
    constructor(config: ConfigService);
    sendSms(params: {
        accountSid: string;
        authToken: string;
        from: string;
        to: string;
        body: string;
    }): Promise<{
        sid?: string;
    }>;
    defaultMessagingFrom(): string | null;
}
