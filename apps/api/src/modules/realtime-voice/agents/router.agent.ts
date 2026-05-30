import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import type { VoiceIntent, VoiceGraphState } from '../types/voice-turn.types';
import {
  isEmailConfirmationAffirmative,
  isEmailConfirmationNegative,
} from '../../calls/runtime/voice-email-capture.util';

const ISBN_RE = /\b(?:97[89]\d{10}|\d{9}[\dXx]|\d{13})\b/;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

/** Fast heuristic router — sub-50ms for common intents; LLM fallback only when ambiguous. */
@Injectable()
export class RouterAgent {
  private readonly logger = new Logger(RouterAgent.name);
  private readonly useLlmRouter: boolean;

  constructor(private readonly config: ConfigService) {
    this.useLlmRouter = this.config.get<string>('REALTIME_ROUTER_LLM') === 'true';
  }

  async route(state: VoiceGraphState): Promise<Partial<VoiceGraphState>> {
    const started = Date.now();
    const text = state.utterance.trim().toLowerCase();

    const heuristic = this.heuristicRoute(text, state.utterance, state.checkoutSession?.stage);
    if (heuristic.confidence >= 0.85) {
      this.logger.debug(
        JSON.stringify({
          event: 'router.heuristic',
          intent: heuristic.intent,
          confidence: heuristic.confidence,
          latencyMs: Date.now() - started,
        }),
      );
      return {
        intent: heuristic.intent,
        intentConfidence: heuristic.confidence,
        escalateToComplexModel: heuristic.intent === 'support' && text.length > 120,
      };
    }

    if (!this.useLlmRouter) {
      return {
        intent: heuristic.intent,
        intentConfidence: heuristic.confidence,
        escalateToComplexModel: false,
      };
    }

    const apiKey =
      state.context.agent.openaiApiKey?.trim() ||
      this.config.get<string>('OPENAI_API_KEY')?.trim();
    if (!apiKey) {
      return { intent: heuristic.intent, intentConfidence: heuristic.confidence };
    }

    try {
      const model = new ChatOpenAI({
        apiKey,
        model: this.config.get<string>('REALTIME_ROUTER_MODEL') ?? 'gpt-4o-mini',
        temperature: 0,
        maxTokens: 32,
      });
      const res = await model.invoke([
        {
          role: 'system',
          content:
            'Classify bookstore phone call intent. Reply with ONE label: greeting, product_search, isbn_search, checkout, email_capture, order_status, support, casual, unknown.',
        },
        { role: 'user', content: state.utterance.slice(0, 500) },
      ]);
      const label = String(res.content).trim().toLowerCase().replace(/[^a-z_]/g, '') as VoiceIntent;
      const valid: VoiceIntent[] = [
        'greeting',
        'product_search',
        'isbn_search',
        'checkout',
        'email_capture',
        'order_status',
        'support',
        'casual',
        'unknown',
      ];
      const intent = valid.includes(label) ? label : heuristic.intent;
      return {
        intent,
        intentConfidence: 0.78,
        escalateToComplexModel: intent === 'support',
      };
    } catch (err) {
      this.logger.warn(`Router LLM fallback: ${(err as Error).message}`);
      return { intent: heuristic.intent, intentConfidence: heuristic.confidence };
    }
  }

  private heuristicRoute(
    lower: string,
    raw: string,
    checkoutStage?: string,
  ): { intent: VoiceIntent; confidence: number } {
    if (!lower) return { intent: 'unknown', confidence: 0.3 };

    if (checkoutStage === 'email_confirmation') {
      if (isEmailConfirmationAffirmative(raw) || isEmailConfirmationNegative(raw)) {
        return { intent: 'email_capture', confidence: 0.95 };
      }
    }
    if (checkoutStage === 'payment_pending' && /\b(resend|send again|paid|payment)\b/i.test(lower)) {
      return { intent: 'checkout', confidence: 0.9 };
    }
    if (checkoutStage === 'awaiting_email' && (EMAIL_RE.test(raw) || /\b(at|dot)\b/i.test(lower))) {
      return { intent: 'email_capture', confidence: 0.92 };
    }
    if (checkoutStage === 'awaiting_product_selection') {
      return { intent: 'product_search', confidence: 0.75 };
    }

    if (/^(hi|hello|hey|good morning|good afternoon|good evening)\b/.test(lower)) {
      return { intent: 'greeting', confidence: 0.95 };
    }
    if (ISBN_RE.test(raw)) return { intent: 'isbn_search', confidence: 0.98 };
    if (EMAIL_RE.test(raw)) return { intent: 'email_capture', confidence: 0.92 };
    if (/\b(checkout|pay|purchase|buy|order it|send (me )?(the )?link|payment link)\b/.test(lower)) {
      return { intent: 'checkout', confidence: 0.9 };
    }
    if (/\b(order status|where('s| is) my order|track(ing)?|shipment|delivery status)\b/.test(lower)) {
      return { intent: 'order_status', confidence: 0.88 };
    }
    if (/\b(isbn|barcode|sku)\b/.test(lower)) return { intent: 'isbn_search', confidence: 0.85 };
    if (
      /\b(book|title|author|novel|copy|available|in stock|do you have|looking for|search for|find)\b/.test(
        lower,
      )
    ) {
      return { intent: 'product_search', confidence: 0.88 };
    }
    if (/\b(email|e-mail|@|spell)\b/.test(lower)) return { intent: 'email_capture', confidence: 0.8 };
    if (/\b(hours|return|refund|policy|help|problem|issue|support)\b/.test(lower)) {
      return { intent: 'support', confidence: 0.82 };
    }
    if (/\b(thanks|thank you|how are you|weather|joke)\b/.test(lower)) {
      return { intent: 'casual', confidence: 0.75 };
    }
    return { intent: 'casual', confidence: 0.55 };
  }
}
