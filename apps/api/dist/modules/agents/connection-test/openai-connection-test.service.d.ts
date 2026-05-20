import type { ConnectionTestResult } from './connection-test.types';
export interface OpenAITestConfig {
    openaiApiKey?: string | null;
}
export declare class OpenAIConnectionTestService {
    private readonly log;
    validateRequired(config: OpenAITestConfig): string | null;
    private sanitizeErrorText;
    private resolveFailureMessage;
    testConnection(config: OpenAITestConfig): Promise<ConnectionTestResult>;
}
