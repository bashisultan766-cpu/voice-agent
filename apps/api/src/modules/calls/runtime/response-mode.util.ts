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
  void args.state;
  void args.customerText;
  const sp = args.toolResult?.searchProducts;
  const ve = args.toolResult?.validateEmail;
  const pay = args.toolResult?.sendPaymentEmail;

  if (pay != null) return 'template';

  if (ve != null && ve.valid === false) return 'template';

  if (sp?.ok === false && sp.errorCode === 'SHOPIFY_SEARCH_FAILED') return 'template';

  if (sp?.ok === true && sp.found === true && !sp.requiresClarification && sp.title?.trim()) {
    return 'template';
  }

  return 'openai';
}
