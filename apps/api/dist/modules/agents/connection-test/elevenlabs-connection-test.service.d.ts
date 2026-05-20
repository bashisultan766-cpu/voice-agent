import { ConfigService } from '@nestjs/config';
import type { ConnectionTestResult } from './connection-test.types';
export interface ElevenLabsTestConfig {
    elevenlabsApiKey?: string | null;
    voiceId?: string | null;
    source?: 'test' | 'save';
    tenantId?: string;
}
export declare class ElevenLabsConnectionTestService {
    private readonly config;
    private readonly log;
    constructor(config: ConfigService);
    private parseErrorText;
    private hasMissingPermission;
    private looksLikeInvalidApiKey;
    private canSynthesizeTinyTest;
    private logDebug;
    validateRequired(config: ElevenLabsTestConfig): string | null;
    testConnection(config: ElevenLabsTestConfig): Promise<ConnectionTestResult>;
}
