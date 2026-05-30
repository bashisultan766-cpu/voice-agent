import { Injectable } from '@nestjs/common';
import { VoiceLongTermMemoryService } from '../memory/voice-long-term-memory.service';
import { VoiceSessionMemoryService } from '../memory/voice-session-memory.service';
import { VoiceCheckoutFlowService } from '../checkout/voice-checkout-flow.service';
import type { AgentTaskResult, VoiceGraphState } from '../types/voice-turn.types';

@Injectable()
export class MemoryAgent {
  constructor(
    private readonly shortTerm: VoiceSessionMemoryService,
    private readonly longTerm: VoiceLongTermMemoryService,
    private readonly checkoutFlow: VoiceCheckoutFlowService,
  ) {}

  async hydrate(state: VoiceGraphState): Promise<AgentTaskResult> {
    const started = Date.now();
    const [sessionMem, longMem, checkoutSession] = await Promise.all([
      this.shortTerm.load(state.callSessionId),
      this.longTerm.load(state.callSessionId),
      this.checkoutFlow.loadSession(state.callSessionId),
    ]);

    const promptHint = this.longTerm.summarizeForPrompt(longMem);
    return {
      agent: 'memory',
      ok: true,
      data: {
        sessionHistoryLength: sessionMem.history.length,
        lastIntent: sessionMem.lastIntent,
        customerEmail: longMem.collectedEmail ?? checkoutSession.confirmedEmail,
        checkoutStage: checkoutSession.stage,
        selectedTitle: checkoutSession.selected?.title,
        promptHint: promptHint.trim() || undefined,
      },
      latencyMs: Date.now() - started,
    };
  }

  async persist(state: VoiceGraphState): Promise<void> {
    const email = state.checkoutSession.confirmedEmail ?? state.memoryPatch.customerEmail;
    await Promise.all([
      this.shortTerm.merge(state.callSessionId, {
        lastIntent: state.intent,
        checkout: state.checkoutSession,
        pendingEmail: state.checkoutSession.pendingEmail,
        lastSearchResults: state.checkoutSession.candidates,
        history: [
          ...state.history,
          { role: 'user' as const, content: state.utterance },
          { role: 'assistant' as const, content: state.reply },
        ].slice(-24),
      }),
      this.longTerm.merge(state.callSessionId, {
        ...(typeof email === 'string' ? { collectedEmail: email, emailCollected: true } : {}),
        ...(state.checkoutSession.selected
          ? {
              cart: {
                items: [
                  {
                    title: state.checkoutSession.selected.title,
                    variantId: state.checkoutSession.selected.variantId,
                    quantity: state.checkoutSession.quantity,
                    price: state.checkoutSession.selected.price,
                  },
                ],
              },
            }
          : {}),
        ...(state.checkoutSession.paymentLinkSent
          ? { checkoutState: 'link_sent' as const }
          : {}),
      }),
      this.checkoutFlow.saveSession(state.callSessionId, state.checkoutSession),
    ]);
  }
}
