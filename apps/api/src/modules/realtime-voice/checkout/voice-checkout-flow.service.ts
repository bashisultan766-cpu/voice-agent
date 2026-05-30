import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { VoiceSessionMemoryService } from '../memory/voice-session-memory.service';
import {
  applyEmailCaptureToSession,
  applyEmailConfirmationToSession,
  applyProductSelectionToSession,
  applySearchResultsToSession,
  canCreatePaymentLink,
  isCheckoutAffirmative,
  isCheckoutInterrupt,
  isResendPaymentEmailRequest,
  mapSearchProducts,
} from './voice-checkout-flow.util';
import { isEmailConfirmationAffirmative } from '../../calls/runtime/voice-email-capture.util';
import { emptyCheckoutSession, type VoiceCheckoutSession } from './voice-checkout-session.types';
import type { AgentTaskResult, VoiceGraphState } from '../types/voice-turn.types';

@Injectable()
export class VoiceCheckoutFlowService {
  constructor(
    private readonly sessionMemory: VoiceSessionMemoryService,
    private readonly prisma: PrismaService,
  ) {}

  async loadSession(callSessionId: string): Promise<VoiceCheckoutSession> {
    const mem = await this.sessionMemory.load(callSessionId);
    return mem.checkout ?? emptyCheckoutSession();
  }

  async saveSession(callSessionId: string, checkout: VoiceCheckoutSession): Promise<void> {
    await this.sessionMemory.merge(callSessionId, { checkout });
  }

  async refreshPaymentStatus(session: VoiceCheckoutSession): Promise<VoiceCheckoutSession> {
    if (!session.checkoutLinkId) return session;
    const link = await this.prisma.checkoutLink.findUnique({
      where: { id: session.checkoutLinkId },
      select: { status: true, completedAt: true },
    });
    if (!link) return session;
    if (link.status === 'COMPLETED') {
      return { ...session, stage: 'payment_completed', paymentStatus: 'completed' };
    }
    if (link.status === 'FAILED' || link.status === 'EXPIRED') {
      return { ...session, paymentStatus: 'failed', lastError: link.status.toLowerCase() };
    }
    return { ...session, paymentStatus: 'pending', stage: 'payment_pending' };
  }

  /** Apply agent results + utterance to checkout session after parallel agents run. */
  applyTurn(state: VoiceGraphState, session: VoiceCheckoutSession): VoiceCheckoutSession {
    let next = { ...session };

    if (isCheckoutInterrupt(state.utterance)) {
      next = { ...emptyCheckoutSession(), interruptedAt: Date.now() };
      return next;
    }

    const search = state.agentResults.find(
      (r) => r.agent === 'shopify_search' || r.agent === 'isbn_search',
    );
    if (search?.ok && search.data) {
      const products = mapSearchProducts(
        ((search.data as { products?: unknown[] }).products ?? []) as Array<{
          id?: string;
          variantId?: string;
          title: string;
          price?: string;
          inStock?: boolean;
        }>,
      );
      if (products.length > 0) {
        next = applySearchResultsToSession(next, products);
      }
    }

    if (next.stage === 'awaiting_product_selection') {
      next = applyProductSelectionToSession(next, state.utterance);
    }

    if (
      next.stage === 'awaiting_email' &&
      isCheckoutAffirmative(state.utterance) &&
      next.selected?.inStock
    ) {
      next = { ...next, stage: 'awaiting_email' };
    }

    const email = state.agentResults.find((r) => r.agent === 'email_verification');
    if (email?.data) {
      const data = email.data as {
        normalized?: string;
        valid?: boolean;
        confirmed?: boolean;
        rejected?: boolean;
        needsConfirmation?: boolean;
      };

      if (data.confirmed && data.normalized) {
        next = {
          ...next,
          confirmedEmail: data.normalized,
          emailConfirmationState: 'confirmed',
        };
      } else if (data.rejected) {
        next = {
          ...next,
          pendingEmail: undefined,
          emailConfirmationState: 'rejected',
          stage: 'awaiting_email',
        };
      } else if (data.valid && data.normalized) {
        next = applyEmailCaptureToSession(next, data.normalized);
      }
    }

    if (next.stage === 'email_confirmation') {
      next = applyEmailConfirmationToSession(next, state.utterance);
    }

    const payment = state.agentResults.find((r) => r.agent === 'payment_link');
    if (payment?.ok && payment.data) {
      const data = payment.data as {
        checkoutUrl?: string;
        checkoutLinkId?: string;
        sent?: boolean;
        paymentStatus?: string;
        resent?: boolean;
      };
      next = {
        ...next,
        checkoutUrl: data.checkoutUrl ?? next.checkoutUrl,
        checkoutLinkId: data.checkoutLinkId ?? next.checkoutLinkId,
        paymentLinkSent: data.sent ?? next.paymentLinkSent,
        stage: data.paymentStatus === 'completed' ? 'payment_completed' : 'payment_pending',
        paymentStatus:
          data.paymentStatus === 'completed'
            ? 'completed'
            : data.sent
              ? 'pending'
              : next.paymentStatus,
      };
    } else if (payment && !payment.ok) {
      next = {
        ...next,
        lastError: payment.error ?? 'checkout_failed',
        checkoutAttempts: next.checkoutAttempts + 1,
      };
    }

    return next;
  }

  shouldRunPaymentLink(state: VoiceGraphState, session: VoiceCheckoutSession): boolean {
    if (isResendPaymentEmailRequest(state.utterance) && session.checkoutLinkId) return true;
    if (
      session.stage === 'email_confirmation' &&
      session.pendingEmail &&
      isEmailConfirmationAffirmative(state.utterance)
    ) {
      return true;
    }
    if (state.intent !== 'checkout' && state.intent !== 'email_capture') return false;
    if (!canCreatePaymentLink(session)) return false;
    if (session.emailConfirmationState !== 'confirmed') return false;
    if (session.paymentLinkSent && !isResendPaymentEmailRequest(state.utterance)) return false;
    return true;
  }

  checkoutMemoryPatch(session: VoiceCheckoutSession): Record<string, unknown> {
    return {
      variantId: session.selected?.variantId,
      email: session.confirmedEmail ?? session.pendingEmail,
      quantity: session.quantity,
      checkoutStage: session.stage,
      checkoutLinkId: session.checkoutLinkId,
      paymentLinkSent: session.paymentLinkSent,
    };
  }
}

export function agentTimedOut(result: AgentTaskResult): boolean {
  return result.error === 'agent_timeout';
}
