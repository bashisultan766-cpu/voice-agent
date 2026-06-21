import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { VoiceSessionContext } from '../calls/runtime/session-context.service';
import { RawInputCaptureService } from './raw-input-capture.service';
import { IntentAnalysisService } from './intent-analysis.service';
import { ResponseOrchestratorService } from './response-orchestrator.service';
import type { OrchestratedVoiceResponse } from './types/intent-analysis.types';

export type VoiceIntentPipelineResult = OrchestratedVoiceResponse & {
  llmUsed: boolean;
  toolNames?: string[];
  turnProof: Record<string, unknown>;
};

@Injectable()
export class VoiceIntentPipelineService {
  private readonly logger = new Logger(VoiceIntentPipelineService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly rawInput: RawInputCaptureService,
    private readonly intentAnalysis: IntentAnalysisService,
    private readonly responseOrchestrator: ResponseOrchestratorService,
  ) {}

  isEnabled(): boolean {
    const raw = (this.config.get<string>('VOICE_INTENT_PIPELINE_ENABLED') ?? 'true')
      .trim()
      .toLowerCase();
    return raw !== 'false' && raw !== '0';
  }

  async processTurn(args: {
    callSessionId: string;
    rawUserText: string;
    orchestratorSpeech: string;
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
    ctx: VoiceSessionContext;
    callerPhone?: string;
  }): Promise<VoiceIntentPipelineResult> {
    const started = Date.now();

    const rawSession = await this.rawInput.captureUserTurn({
      callSessionId: args.callSessionId,
      rawText: args.rawUserText,
      persistTranscript: false,
    });

    const intent = await this.intentAnalysis.analyze({
      callSessionId: args.callSessionId,
      rawSession,
    });

    const orchestrated = await this.responseOrchestrator.orchestrate({
      callSessionId: args.callSessionId,
      intent,
      orchestratorSpeech: args.orchestratorSpeech,
      conversationHistory: args.conversationHistory,
      ctx: args.ctx,
      callerPhone: args.callerPhone,
      rawUserText: args.rawUserText,
    });

    await this.rawInput.captureAssistantTurn({
      callSessionId: args.callSessionId,
      rawText: orchestrated.text_response,
      persistTranscript: false,
    });

    const turnProof: Record<string, unknown> = {
      pipeline: 'enterprise_call_center',
      intent: intent.intent,
      multi_intent: intent.multi_intent,
      emotion: intent.emotion,
      urgency: intent.urgency,
      refund_risk: intent.refund_risk,
      route: orchestrated.route?.route,
      human_queue: orchestrated.human_queue ?? false,
      escalation_id: orchestrated.escalation_id ?? null,
      actions: intent.actions,
      actions_executed: orchestrated.actions_executed.map((a) => a.action),
      intentSource: intent.source,
      llmUsed: orchestrated.llmUsed,
      llmSkipped: !orchestrated.llmUsed,
      voiceTextChars: orchestrated.voice_text.length,
      textResponseChars: orchestrated.text_response.length,
      rawInputChars: args.rawUserText.length,
      latencyMs: Date.now() - started,
    };

    this.logger.log(
      JSON.stringify({
        event: 'voice.intent_pipeline.complete',
        callSessionId: args.callSessionId,
        ...turnProof,
      }),
    );

    return {
      ...orchestrated,
      llmUsed: orchestrated.llmUsed,
      toolNames: orchestrated.toolNames,
      turnProof,
    };
  }
}
