import type { UserUtteranceIntent } from './user-intent-classifier.util';
import type { OrderState } from './order-state-machine.util';
import type { VoiceTurnToolTrace } from './voice-turn-tool-trace.util';

/**
 * Default spoken path is OpenAI. Templates are only for safety-critical or
 * strictly factual tool formatting (price/stock from catalog).
 */
export function decideResponseMode(args: {
  intent: UserUtteranceIntent;
  state: OrderState;
  toolResult?: VoiceTurnToolTrace;
  customerText: string;
}): 'template' | 'openai' {
  void args.intent;
  void args.customerText;
  const ve = args.toolResult?.validateEmail;

  if (
    ve != null &&
    ve.valid === false &&
    (args.state === 'EMAIL_COLLECTING' || args.state === 'EMAIL_CONFIRMING' || args.state === 'EMAIL_COLLECTION')
  ) {
    return 'template';
  }

  return 'openai';
}
