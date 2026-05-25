import type { CallConversationMemory, VoicePersonalityTraits } from '@bookstore-voice-agents/types';
import type { ConversationStage } from './conversation-stage.util';
import type { ObjectionType } from './objection-patterns.util';
import type { UserUtteranceIntent } from './user-intent-classifier.util';
import type { OrderState } from './order-state-machine.util';
import {
  extractInterestSignalsFromText,
  extractGenrePreferencesFromText,
  priceSensitivityFromText,
  purchaseUrgencyFromText,
} from './product-recommendation.util';

export type SalesTurnPlan = {
  salesGuidance: string;
  discoveryQuestion: string | null;
  upsellHint: string | null;
  crossSellHint: string | null;
  urgencyHint: string | null;
  confidenceLine: string | null;
  memoryPatch: Partial<CallConversationMemory>;
};

export type SalesTurnInput = {
  userText: string;
  stage: ConversationStage;
  userIntent: UserUtteranceIntent;
  orderState: OrderState;
  objectionType: ObjectionType | null;
  memory: CallConversationMemory;
  personality?: VoicePersonalityTraits | null;
  hasProductDiscussed: boolean;
};

function discoveryQuestionForStage(
  memory: CallConversationMemory,
  userText: string,
): string | null {
  const signals = extractInterestSignalsFromText(userText);
  const genres = extractGenrePreferencesFromText(userText);
  if (memory.preferredGenres?.length || memory.interestSignals?.length) return null;

  if (signals.includes('inmates-popular')) {
    return 'Are you shopping for someone inside, or for yourself — and do you prefer fiction or nonfiction?';
  }
  if (genres.length) {
    return `Great — within ${genres[0]}, do you want something new, or a well-known title?`;
  }
  if (signals.includes('easy-reading')) {
    return 'Would you like something short and easy to read, or a longer story?';
  }
  return 'What genre or topic should I start with — or do you have an author or ISBN in mind?';
}

function upsellAggressiveness(personality?: VoicePersonalityTraits | null): number {
  return personality?.upsellAggressiveness ?? 35;
}

export function buildSalesTurnPlan(input: SalesTurnInput): SalesTurnPlan {
  const { memory, stage, userIntent, objectionType, orderState, personality } = input;
  const interestSignals = [
    ...new Set([
      ...(memory.interestSignals ?? []),
      ...extractInterestSignalsFromText(input.userText),
    ]),
  ];
  const genres = [
    ...new Set([
      ...(memory.preferredGenres ?? []),
      ...extractGenrePreferencesFromText(input.userText),
    ]),
  ];
  const priceSensitivity = priceSensitivityFromText(input.userText) ?? memory.priceSensitivity ?? 'medium';
  const purchaseUrgency = purchaseUrgencyFromText(input.userText) ?? memory.purchaseUrgency ?? 'low';

  const lines: string[] = [
    'Sales conversation mode (conversion-focused, not support-only):',
    '- Lead with helpful discovery, then recommend max two in-stock titles from Shopify tools.',
    '- Use soft upsell only when natural (related title or format); never pressure.',
    '- Reinforce confidence with tool-backed facts (price, stock) before asking for checkout.',
  ];

  let discoveryQuestion: string | null = null;
  if (stage === 'DISCOVERY' || (stage === 'GREETING' && !input.hasProductDiscussed)) {
    discoveryQuestion = discoveryQuestionForStage(memory, input.userText);
    if (discoveryQuestion) {
      lines.push(`Discovery: ask one question — "${discoveryQuestion}"`);
    }
  }

  let upsellHint: string | null = null;
  let crossSellHint: string | null = null;
  const agg = upsellAggressiveness(personality);
  if (input.hasProductDiscussed && agg >= 50 && stage === 'RECOMMENDATION') {
    upsellHint = 'If they liked the title, mention one related in-stock option from search — one sentence only.';
  }
  if (genres.length >= 2 || interestSignals.length >= 2) {
    crossSellHint = 'Cross-sell: bridge their stated interests; search once for the strongest overlap.';
  }

  let urgencyHint: string | null = null;
  if (purchaseUrgency === 'high') {
    urgencyHint =
      'Caller sounds time-sensitive: confirm in-stock items quickly and offer to send checkout link today.';
    lines.push(urgencyHint);
  } else if (purchaseUrgency === 'medium') {
    urgencyHint = 'Acknowledge timing politely; keep momentum without rushing.';
  }

  let confidenceLine: string | null = null;
  if (stage === 'CHECKOUT_CONFIRMATION' || stage === 'PAYMENT_LINK_CONFIRMATION') {
    confidenceLine =
      'Reassure them the secure Shopify link is the safest way to pay; confirm email once.';
    lines.push(confidenceLine);
  } else if (objectionType === 'too_expensive' || objectionType === 'need_cheaper') {
    confidenceLine =
      'Validate budget; offer one lower-priced in-stock alternative from search — never invent prices.';
    lines.push(confidenceLine);
  }

  if (objectionType) {
    lines.push(`Objection (${objectionType}): acknowledge, use tools/facts, one gentle next step toward purchase.`);
  }

  if (interestSignals.length) {
    lines.push(`Interest signals: ${interestSignals.join(', ')}. Search catalog with these themes.`);
  }
  if (genres.length) {
    lines.push(`Genre affinity: ${genres.join(', ')}.`);
  }
  if (priceSensitivity === 'high') {
    lines.push('Budget-sensitive caller: prioritize lower in-stock prices; avoid premium upsell.');
  }

  if (orderState === 'EMAIL_COLLECTION') {
    lines.push('Checkout: collect email spelling; then payment link — recover politely if they hesitate.');
  }

  const memoryPatch: Partial<CallConversationMemory> = {
    priceSensitivity,
    purchaseUrgency,
    interestSignals,
    ...(genres.length ? { preferredGenres: genres } : {}),
    ...(discoveryQuestion ? { lastDiscoveryQuestion: discoveryQuestion } : {}),
    customerPreferences: {
      ...memory.customerPreferences,
      priceSensitivity,
      purchaseUrgency,
      interests: interestSignals.join(', '),
    },
  };

  void userIntent;

  return {
    salesGuidance: lines.join('\n'),
    discoveryQuestion,
    upsellHint,
    crossSellHint,
    urgencyHint,
    confidenceLine,
    memoryPatch,
  };
}
