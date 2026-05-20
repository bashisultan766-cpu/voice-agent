import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
export declare class TwilioSignatureService {
    private readonly config;
    constructor(config: ConfigService);
    private isTrustedProxyUrlHeader;
    isValidationEnabled(): boolean;
    validate(url: string, params: Record<string, string>, signature: string): boolean;
    resolveValidationUrl(req: Request): string;
    private sortedParams;
}
