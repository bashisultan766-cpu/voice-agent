import { ConfigService } from '@nestjs/config';
import { OpenAIPromptBuilderService } from './openai-prompt-builder.service';
import { OpenAIToolRegistryService } from './openai-tool-registry.service';
import { SessionContextService } from '../../calls/runtime/session-context.service';
import { ToolOrchestratorService } from '../../calls/runtime/tool-orchestrator.service';
import { type VoiceTurnToolTrace } from '../../calls/runtime/voice-turn-tool-trace.util';
export type { VoiceTurnToolTrace } from '../../calls/runtime/voice-turn-tool-trace.util';
export interface ProcessTurnResult {
    message: string;
    toolCallsCount: number;
    escalated?: boolean;
    toolTrace?: VoiceTurnToolTrace;
    error?: {
        code: 'OPENAI_429' | 'OPENAI_401' | 'OPENAI_ERROR';
        status?: number;
        message?: string;
    };
    proof?: {
        openaiKeySource: string;
        modelUsed: string;
        openaiCalled: boolean;
        openaiSuccess: boolean;
        replyPreview: string;
    };
}
export declare class OpenAIVoiceService {
    private readonly config;
    private readonly promptBuilder;
    private readonly toolRegistry;
    private readonly sessionContext;
    private readonly toolOrchestrator;
    private readonly logger;
    constructor(config: ConfigService, promptBuilder: OpenAIPromptBuilderService, toolRegistry: OpenAIToolRegistryService, sessionContext: SessionContextService, toolOrchestrator: ToolOrchestratorService);
    processTurn(callSessionId: string, userMessage: string, conversationHistory: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>): Promise<ProcessTurnResult>;
}
