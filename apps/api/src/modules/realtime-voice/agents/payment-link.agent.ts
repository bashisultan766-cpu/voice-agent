import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { ShopifyCheckoutService } from '../../integrations/shopify/shopify-checkout.service';
import { ResendEmailService } from '../../integrations/email/resend-email.service';
import { isResendPaymentEmailRequest, canCreatePaymentLink } from '../checkout/voice-checkout-flow.util';
import { VoiceE2ETraceService } from '../observability/voice-e2e-trace.service';
import { isEmailConfirmationAffirmative } from '../../calls/runtime/voice-email-capture.util';
import type { AgentTaskResult, VoiceGraphState } from '../types/voice-turn.types';

const MAX_CHECKOUT_RETRIES = 2;
const MAX_EMAIL_SEND_RETRIES = 2;
const CHECKOUT_TOOL_TIMEOUT_MS = 2500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

@Injectable()
export class PaymentLinkAgent {
  private readonly logger = new Logger(PaymentLinkAgent.name);

  constructor(
    private readonly checkout: ShopifyCheckoutService,
    private readonly email: ResendEmailService,
    private readonly prisma: PrismaService,
    private readonly e2eTrace: VoiceE2ETraceService,
  ) {}

  async createLink(state: VoiceGraphState): Promise<AgentTaskResult> {
    const started = Date.now();
    const { tenantId, agentId } = state.context;
    const session = state.checkoutSession;

    if (session.checkoutLinkId && isResendPaymentEmailRequest(state.utterance)) {
      return this.resendExistingLink(state, started);
    }

    if (session.checkoutLinkId && session.paymentStatus === 'pending') {
      const refreshed = await this.refreshStatus(session.checkoutLinkId);
      if (refreshed === 'completed') {
        void this.e2eTrace.record(state.callSessionId, 'payment_status_checked', {
          ok: true,
          provider: 'postgres',
          metadata: { status: 'completed' },
        });
        return {
          agent: 'payment_link',
          ok: true,
          data: { paymentStatus: 'completed', checkoutLinkId: session.checkoutLinkId },
          latencyMs: Date.now() - started,
        };
      }
    }

    let workingSession = { ...session };
    if (
      workingSession.stage === 'email_confirmation' &&
      workingSession.pendingEmail &&
      isEmailConfirmationAffirmative(state.utterance)
    ) {
      workingSession = {
        ...workingSession,
        confirmedEmail: workingSession.pendingEmail,
        emailConfirmationState: 'confirmed',
      };
    }

    if (!canCreatePaymentLink(workingSession)) {
      return {
        agent: 'payment_link',
        ok: false,
        error: workingSession.selected?.inStock === false ? 'out_of_stock' : 'checkout_preconditions_not_met',
        latencyMs: Date.now() - started,
      };
    }

    const variantId = workingSession.selected!.variantId;
    const email = workingSession.confirmedEmail!;
    const quantity = workingSession.quantity ?? 1;
    const title = workingSession.selected!.title;

    let lastError = 'checkout_failed';
    for (let attempt = 0; attempt <= MAX_CHECKOUT_RETRIES; attempt += 1) {
      try {
        const checkoutResult = await Promise.race([
          this.checkout.createCheckoutLink(tenantId, agentId, {
            items: [{ variantId, quantity, title }],
            customer: { email },
            callSessionId: state.callSessionId,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('checkout_timeout')), CHECKOUT_TOOL_TIMEOUT_MS),
          ),
        ]);

        let sent = false;
        let sendError: string | undefined;
        for (let sendAttempt = 0; sendAttempt <= MAX_EMAIL_SEND_RETRIES; sendAttempt += 1) {
          try {
            const emailResult = await this.email.sendPaymentEmail({
              tenantId,
              agentId,
              callSessionId: state.callSessionId,
              checkoutLinkId: checkoutResult.checkoutLinkId,
              to: email,
              businessName: state.context.store.name,
              checkoutUrl: checkoutResult.checkoutUrl,
              items: [{ title, quantity, price: workingSession.selected!.price ?? null }],
            });
            sent = emailResult.success || emailResult.deduplicated === true;
            if (sent) break;
            sendError = 'email_send_failed';
          } catch (emailErr) {
            sendError = (emailErr as Error).message;
            this.logger.warn(`Payment email attempt ${sendAttempt + 1} failed: ${sendError}`);
            if (sendAttempt < MAX_EMAIL_SEND_RETRIES) await sleep(300);
          }
        }

        return {
          agent: 'payment_link',
          ok: true,
          data: {
            checkoutUrl: checkoutResult.checkoutUrl,
            checkoutLinkId: checkoutResult.checkoutLinkId,
            sent,
            sendError,
            paymentStatus: 'pending',
            reusedExisting: checkoutResult.reusedExisting,
          },
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        lastError = (err as Error).message;
        this.logger.warn(`Checkout attempt ${attempt + 1} failed: ${lastError}`);
        if (attempt < MAX_CHECKOUT_RETRIES) await sleep(250);
      }
    }

    return {
      agent: 'payment_link',
      ok: false,
      error: lastError,
      data: { paymentStatus: 'failed', retryExhausted: true },
      latencyMs: Date.now() - started,
    };
  }

  private async resendExistingLink(state: VoiceGraphState, started: number): Promise<AgentTaskResult> {
    const session = state.checkoutSession;
    const { tenantId, agentId } = state.context;
    const email = session.confirmedEmail ?? session.pendingEmail;
    if (!email || !session.checkoutLinkId || !session.checkoutUrl) {
      return {
        agent: 'payment_link',
        ok: false,
        error: 'nothing_to_resend',
        latencyMs: Date.now() - started,
      };
    }

    try {
      const emailResult = await this.email.sendPaymentEmail({
        tenantId,
        agentId,
        callSessionId: state.callSessionId,
        checkoutLinkId: session.checkoutLinkId,
        to: email,
        businessName: state.context.store.name,
        checkoutUrl: session.checkoutUrl,
        items: [
          {
            title: session.selected?.title ?? 'Your book',
            quantity: session.quantity ?? 1,
            price: session.selected?.price ?? null,
          },
        ],
        idempotencyKey: `resend:${session.checkoutLinkId}:${Date.now()}`,
      });

      return {
        agent: 'payment_link',
        ok: true,
        data: {
          checkoutUrl: session.checkoutUrl,
          checkoutLinkId: session.checkoutLinkId,
          sent: emailResult.success || emailResult.deduplicated === true,
          resent: true,
          paymentStatus: session.paymentStatus ?? 'pending',
        },
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      return {
        agent: 'payment_link',
        ok: false,
        error: (err as Error).message,
        latencyMs: Date.now() - started,
      };
    }
  }

  private async refreshStatus(checkoutLinkId: string): Promise<'pending' | 'completed' | 'failed'> {
    const link = await this.prisma.checkoutLink.findUnique({
      where: { id: checkoutLinkId },
      select: { status: true },
    });
    if (!link) return 'failed';
    if (link.status === 'COMPLETED') return 'completed';
    if (link.status === 'FAILED' || link.status === 'EXPIRED') return 'failed';
    return 'pending';
  }
}
