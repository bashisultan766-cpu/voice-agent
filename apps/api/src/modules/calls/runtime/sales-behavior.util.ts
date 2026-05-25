import type { AdaptiveVoiceBehavior } from './adaptive-voice-behavior.util';
import type { ConversationStage } from './conversation-stage.util';

const TRANSITION_BY_STAGE: Partial<Record<ConversationStage, string[]>> = {
  DISCOVERY: ['So,', 'To help narrow it down,'],
  RECOMMENDATION: ['Based on that,', 'From what you said,'],
  OBJECTION_HANDLING: ['I understand.', 'That makes sense.'],
  CHECKOUT_CONFIRMATION: ['Great —', 'Perfect —'],
  PAYMENT_LINK_CONFIRMATION: ['All set —', 'Quick confirm —'],
};

export type HumanSalesBehaviorInput = {
  reply: string;
  adaptive: AdaptiveVoiceBehavior;
  stage: ConversationStage;
  reassurance?: string | null;
  useMicroPause?: boolean;
};

/**
 * Shapes spoken replies: empathy lead, soft transitions, optional micro-pause between sentences.
 */
export function applyHumanSalesBehavior(input: HumanSalesBehaviorInput): string {
  let text = input.reply.trim();
  if (!text) return text;

  const parts: string[] = [];
  if (input.adaptive.empathyLead && !text.toLowerCase().startsWith(input.adaptive.empathyLead.toLowerCase().slice(0, 8))) {
    parts.push(input.adaptive.empathyLead);
  }
  if (input.reassurance?.trim() && !text.includes(input.reassurance.trim())) {
    parts.push(input.reassurance.trim());
  }

  const transitions = TRANSITION_BY_STAGE[input.stage];
  if (transitions?.length && text.length > 40) {
    const t = transitions[0]!;
    if (!text.startsWith(t)) {
      text = `${t} ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
    }
  }

  if (input.useMicroPause !== false && text.includes('. ')) {
    text = text.replace(/\. /g, '. — ');
  }

  if (parts.length) {
    return `${parts.join(' ')} ${text}`.replace(/\s+/g, ' ').trim();
  }
  return text;
}

export function confidenceReinforcementPhrase(stage: ConversationStage): string | null {
  if (stage === 'RECOMMENDATION') {
    return 'This is in stock at our store right now.';
  }
  if (stage === 'CHECKOUT_CONFIRMATION') {
    return 'You will get a secure Shopify link — safest way to complete payment.';
  }
  return null;
}
