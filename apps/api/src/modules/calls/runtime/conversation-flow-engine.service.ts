import { Injectable } from '@nestjs/common';
import type { CallConversationMemory, CallRuntimeAnalytics } from '@bookstore-voice-agents/types';
import { CallMemoryService } from './call-memory.service';
import {
  advanceConversationStage,
  normalizeConversationStage,
  shouldUseFastVoicePath,
  type ConversationStage,
} from './conversation-stage.util';
import { classifyConversationalObjection } from './objection-patterns.util';
import { extractGenrePreferencesFromText } from './product-recommendation.util';
import { classifyUserIntent, type UserUtteranceIntent } from './user-intent-classifier.util';
import { normalizeOrderState, type OrderState } from './order-state-machine.util';
import type { OrderTurnIntent } from './order-intent-classifier.util';

export type ConversationTurnContext = {
  callSessionId: string;
  userText: string;
  orderState: OrderState;
  orderIntent: OrderTurnIntent;
  toolCallAllowed: boolean;
  paymentLinkSent?: boolean;
};

export type ConversationTurnPlan = {
  stage: ConversationStage;
  stageGuidance: string;
  userIntent: UserUtteranceIntent;
  objectionType: string | null;
  memory: CallConversationMemory;
  memorySummary: string;
  useFastVoicePath: boolean;
  analyticsPatch: Partial<CallRuntimeAnalytics>;
};

@Injectable()
export class ConversationFlowEngineService {
  constructor(private readonly callMemory: CallMemoryService) {}

  async planTurn(ctx: ConversationTurnContext): Promise<ConversationTurnPlan> {
    const memory = await this.callMemory.load(ctx.callSessionId);
    const userIntent = classifyUserIntent(ctx.userText);
    const objection = classifyConversationalObjection(ctx.userText);
    const orderState = normalizeOrderState(ctx.orderState);
    const currentStage = normalizeConversationStage(memory.conversationStage);

    const genres = extractGenrePreferencesFromText(ctx.userText);
    const nameMatch = ctx.userText.match(
      /\b(?:my name is|i am|i'm|this is)\s+([a-z][a-z\s'-]{1,40})/i,
    );
    const memPatch: Partial<CallConversationMemory> = {
      lastIntent: userIntent,
      ...(genres.length
        ? {
            customerPreferences: {
              ...memory.customerPreferences,
              genres: [...new Set([...(memory.preferredGenres ?? []), ...genres])].join(', '),
            },
            preferredGenres: [...new Set([...(memory.preferredGenres ?? []), ...genres])],
          }
        : {}),
      ...(nameMatch?.[1]
        ? { customerName: nameMatch[1].trim().split(/\s+/).slice(0, 3).join(' ') }
        : {}),
      ...(objection ? { lastObjection: objection.type } : {}),
    };

    const discussed = (memory.discussedProducts ?? memory.mentionedProducts ?? []).length > 0;
    const emailConfirmed = memory.emailConfirmationState === 'confirmed';
    const { nextStage, guidance } = advanceConversationStage({
      currentStage,
      orderState,
      userIntent,
      objection: objection?.type ?? null,
      hasProductDiscussed: discussed,
      paymentLinkSent: Boolean(ctx.paymentLinkSent ?? memory.checkoutState === 'link_sent'),
      emailConfirmed,
    });

    memPatch.conversationStage = nextStage;
    if (orderState === 'EMAIL_COLLECTION') {
      memPatch.checkoutState = 'email_pending';
    }
    if (ctx.orderIntent === 'email_provided') {
      memPatch.emailConfirmationState = 'pending';
    }

    const merged = await this.callMemory.merge(ctx.callSessionId, memPatch);
    const useFast = shouldUseFastVoicePath(userIntent, nextStage, ctx.toolCallAllowed);

    const analyticsPatch: Partial<CallRuntimeAnalytics> = {
      lastStage: nextStage,
      lastUserIntent: userIntent,
      ...(objection ? { objectionCounts: { [objection.type]: 1 } } : {}),
    };

    return {
      stage: nextStage,
      stageGuidance: guidance,
      userIntent,
      objectionType: objection?.type ?? null,
      memory: merged,
      memorySummary: this.callMemory.summarizeForPrompt(merged),
      useFastVoicePath: useFast,
      analyticsPatch,
    };
  }
}
