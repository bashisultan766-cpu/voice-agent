import { Injectable, Logger } from '@nestjs/common';
import { summarizeForVoice, stubIntentForVoiceSummary } from '../voice-intent-pipeline/voice-summarizer.util';
import type {
  VoiceControlledResponse,
  VoiceResponseAction,
} from './types/voice-controlled-response.types';
import type { IntentAnalysisResult, ActionExecutionRecord } from '../voice-intent-pipeline/types/intent-analysis.types';

export type VoiceResponseBuildHints = {
  action?: VoiceResponseAction;
  userIntent?: string;
  toolNames?: string[];
  intent?: IntentAnalysisResult;
  actions_executed?: ActionExecutionRecord[];
};

@Injectable()
export class VoiceResponseControllerService {
  private readonly logger = new Logger(VoiceResponseControllerService.name);

  build(args: {
    text: string;
    hints?: VoiceResponseBuildHints;
  }): VoiceControlledResponse {
    const text_response = args.text.replace(/\s+/g, ' ').trim();
    const action = args.hints?.action ?? this.inferAction(text_response, args.hints);

    const voice_text =
      args.hints?.intent && args.hints.actions_executed
        ? summarizeForVoice({
            text_response,
            intent: args.hints.intent,
            actions_executed: args.hints.actions_executed,
          })
        : summarizeForVoice({
            text_response,
            intent: args.hints?.intent ?? stubIntentForVoiceSummary(text_response, action),
            actions_executed: args.hints?.actions_executed ?? [],
          });

    const response: VoiceControlledResponse = {
      text_response,
      action,
      voice_text: voice_text || text_response.slice(0, 220),
    };

    this.logger.debug(
      JSON.stringify({
        event: 'voice.response.built',
        textChars: text_response.length,
        voiceChars: response.voice_text.length,
        action,
      }),
    );

    return response;
  }

  private inferAction(text: string, hints?: VoiceResponseBuildHints): VoiceResponseAction {
    if (hints?.action) return hints.action;
    if (hints?.intent?.actions[0]) {
      const a = hints.intent.actions[0];
      if (a === 'shipping_check') return 'shipping_status';
      if (a === 'cancel') return 'cancel_order';
      return a as VoiceResponseAction;
    }

    const tools = hints?.toolNames ?? [];
    if (tools.some((t) => /cancel/i.test(t))) return 'cancel_order';
    if (tools.some((t) => /refund|return/i.test(t))) return 'refund';
    if (tools.some((t) => /payment|checkout|link/i.test(t))) return 'payment_link';
    if (tools.some((t) => /order|track|shipping/i.test(t))) return 'order_lookup';
    if (tools.some((t) => /search|product|catalog/i.test(t))) return 'product_search';
    if (tools.some((t) => /escalat|human|support/i.test(t))) return 'escalate';

    const t = text.toLowerCase();
    if (/\b(cancel(l)?ed|cancellation)\b/.test(t)) return 'cancel_order';
    if (/\b(refund|return)\b/.test(t)) return 'refund';
    if (/\b(payment link|checkout link|pay securely)\b/.test(t)) return 'payment_link';
    if (/\b(shipping|tracking|carrier|delivered|in transit)\b/.test(t)) return 'shipping_status';
    if (/\b(order #|order number|order status|lookup)\b/.test(t)) return 'order_lookup';
    if (/\b(escalat|human agent|specialist|manager)\b/.test(t)) return 'escalate';
    if (/\b(book|isbn|title|catalog|search)\b/.test(t)) return 'product_search';

    const intent = hints?.userIntent ?? '';
    if (intent === 'order_status' || intent === 'order_lookup') return 'order_lookup';
    if (intent === 'product_search') return 'product_search';
    if (intent === 'payment_question') return 'payment_link';

    return 'general';
  }
}
