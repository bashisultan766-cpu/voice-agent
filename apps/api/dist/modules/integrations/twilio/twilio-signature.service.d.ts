import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { TwilioAuthTokenResolverService } from './twilio-auth-token-resolver.service';
export declare class TwilioSignatureService {
    private readonly config;
    private readonly authTokenResolver;
    constructor(config: ConfigService, authTokenResolver: TwilioAuthTokenResolverService);
    private isTrustedProxyUrlHeader;
    isValidationEnabled(): boolean;
    validateWithToken(url: string, params: Record<string, string>, signature: string, authToken: string): boolean;
    validate(url: string, params: Record<string, string>, signature: string): boolean;
    validateInbound(url: string, params: Record<string, string>, signature: string): Promise<boolean>;
    resolveValidationUrl(req: Request): string;
    private sortedParams;
}
