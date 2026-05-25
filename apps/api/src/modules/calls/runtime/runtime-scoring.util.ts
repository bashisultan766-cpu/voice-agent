import type { CallConversationMemory, CallRuntimeAnalytics, RuntimeConversationScores } from '@bookstore-voice-agents/types';
import type { ConversationStage } from './conversation-stage.util';

export type RuntimeScoreInput = {
  stage: ConversationStage;
  memory: CallConversationMemory;
  analytics: CallRuntimeAnalytics;
  hallucinationAttempt: boolean;
  toolCallsCount: number;
  searchSucceeded: boolean;
  replyChars: number;
  adaptiveMood: string;
  objectionHandled: boolean;
};

export function computeRuntimeScores(input: RuntimeScoreInput): RuntimeConversationScores {
  let conversationQuality = 72;
  let salesEffectiveness = 55;
  let hallucinationRisk = 12;
  let empathy = 70;

  if (input.replyChars > 20 && input.replyChars < 400) conversationQuality += 8;
  if (input.replyChars > 450) conversationQuality -= 10;
  if (input.toolCallsCount > 0 && input.searchSucceeded) conversationQuality += 6;

  if (input.stage === 'RECOMMENDATION' || input.stage === 'CHECKOUT_CONFIRMATION') {
    salesEffectiveness += 10;
  }
  if (input.memory.cart?.items?.length) salesEffectiveness += 12;
  if ((input.analytics.checkoutAttempts ?? 0) > 0) salesEffectiveness += 8;
  if (input.analytics.checkoutConverted) salesEffectiveness += 20;
  if ((input.analytics.recommendationAccepted ?? 0) > 0) salesEffectiveness += 10;
  if ((input.analytics.recommendationDeclined ?? 0) > 2) salesEffectiveness -= 8;

  if (input.hallucinationAttempt) hallucinationRisk += 35;
  if ((input.analytics.hallucinationAttempts ?? 0) > 0) {
    hallucinationRisk += Math.min(25, (input.analytics.hallucinationAttempts ?? 0) * 8);
  }
  if (!input.searchSucceeded && input.stage === 'RECOMMENDATION') hallucinationRisk += 5;

  if (input.adaptiveMood === 'frustrated' || input.adaptiveMood === 'confused') empathy += 12;
  if (input.adaptiveMood === 'excited') empathy += 6;
  if (input.objectionHandled) empathy += 8;
  if (input.memory.customerName) empathy += 4;

  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

  return {
    conversationQuality: clamp(conversationQuality),
    salesEffectiveness: clamp(salesEffectiveness),
    hallucinationRisk: clamp(hallucinationRisk),
    empathy: clamp(empathy),
    updatedAt: new Date().toISOString(),
  };
}
