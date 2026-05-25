import { SessionContextService } from './session-context.service';
import { CallsService } from '../calls.service';
import { OpenAIVoiceService } from '../../integrations/openai/openai-voice.service';
import { OpenAIPromptBuilderService } from '../../integrations/openai/openai-prompt-builder.service';
import { CallEventsService } from '../../analytics/call-events.service';
import { CallOutcomeService } from '../../analytics/call-outcome.service';
import { TranscriptBufferService } from './transcript-buffer.service';
import { ToolOrchestratorService } from './tool-orchestrator.service';
import { RuntimeSafetyService } from './runtime-safety.service';
export declare class VoiceRuntimeService {
    private readonly sessionContext;
    private readonly callsService;
    private readonly openaiVoice;
    private readonly tools;
    private readonly callEvents;
    private readonly callOutcome;
    private readonly transcriptBuffer;
    private readonly promptBuilder;
    private readonly runtimeSafety;
    private readonly logger;
    constructor(sessionContext: SessionContextService, callsService: CallsService, openaiVoice: OpenAIVoiceService, tools: ToolOrchestratorService, callEvents: CallEventsService, callOutcome: CallOutcomeService, transcriptBuffer: TranscriptBufferService, promptBuilder: OpenAIPromptBuilderService, runtimeSafety: RuntimeSafetyService);
    private deterministicFallbackEnabled;
    private professionalReplyFromSearchTool;
    private appendConversationalMomentum;
    private normalizeForRepeatCheck;
    private hasSpecificProductSignalForSearch;
    private evaluateSearchToolPolicy;
    private applyRepeatGuard;
    private buildNonRepeatingVariant;
    private buildConciseIdentityOrCapabilityReply;
    private resolveSpokenReplyAfterOpenAI;
    private buildTemplateReply;
    private isDeliveryQuestion;
    private respondDeterministicallyOnOpenAI429;
    getGreeting(callSessionId: string): Promise<string>;
    buildSystemPrompt(callSessionId: string): Promise<string>;
    onRuntimeConnected(callSessionId: string): Promise<void>;
    onRuntimeDisconnected(callSessionId: string): Promise<void>;
    processUtterance(callSessionId: string, text: string, conversationHistory?: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>): Promise<{
        reply: string;
        turnProof?: Record<string, unknown>;
    }>;
    private logTurnProof;
}
