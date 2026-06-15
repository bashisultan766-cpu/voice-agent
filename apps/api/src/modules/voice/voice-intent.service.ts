import { Injectable, Logger } from '@nestjs/common';
import {
  classifySureShotVoiceIntent,
  type SureShotIntentResult,
} from './utils/normalize-voice-intent.util';
import { maskRawSpeechForLog } from '../calls/runtime/voice-email-capture.util';

export type NormalizeIntentInput = {
  transcript: string;
  callerPhone?: string | null;
  callSid?: string | null;
};

export type NormalizeIntentResponse = SureShotIntentResult & {
  callerPhone: string | null;
  callSid: string | null;
};

@Injectable()
export class VoiceIntentService {
  private readonly logger = new Logger(VoiceIntentService.name);

  normalizeIntent(input: NormalizeIntentInput): NormalizeIntentResponse {
    const transcript = input.transcript?.trim() ?? '';
    const result = classifySureShotVoiceIntent(transcript);

    this.logger.log(
      JSON.stringify({
        event: 'intent_detected',
        intent: result.intent,
        suggestedAction: result.suggestedAction,
        isOrderRelated: result.isOrderRelated,
        blocksMedicalRefusal: result.blocksMedicalRefusal,
        matchedKeywords: result.matchedKeywords,
        callSid: input.callSid ?? null,
      }),
    );

    this.logger.log(
      JSON.stringify({
        event: 'transcript_raw',
        preview: maskRawSpeechForLog(result.transcriptRaw),
        callSid: input.callSid ?? null,
      }),
    );

    this.logger.log(
      JSON.stringify({
        event: 'transcript_normalized',
        preview: result.transcriptNormalized.slice(0, 120),
        callSid: input.callSid ?? null,
      }),
    );

    return {
      ...result,
      callerPhone: input.callerPhone?.trim() || null,
      callSid: input.callSid?.trim() || null,
    };
  }

  logAgentToolFailure(toolName: string, message: string, callSid?: string | null): void {
    this.logger.warn(
      JSON.stringify({
        event: 'agent_tool_failure',
        toolName,
        message: message.slice(0, 400),
        callSid: callSid ?? null,
      }),
    );
  }
}
