import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { CallsService } from '../../calls/calls.service';
import { SessionContextService } from '../../calls/runtime/session-context.service';
import { RealtimeVoiceOrchestratorService } from '../orchestrator/realtime-voice-orchestrator.service';
import { VoiceE2ETraceService } from '../observability/voice-e2e-trace.service';
import type { VoiceE2EStagingReport, VoiceE2EStepRecord } from '../observability/voice-e2e-trace.types';
import { ShopifyService } from '../../integrations/shopify/shopify.service';
import { CheckoutLinkStatus, EmailDeliveryStatus } from '@prisma/client';
import type { ConversationTurn } from '../types/voice-turn.types';

export type SyntheticCallRunnerOptions = {
  tenantId: string;
  agentId: string;
  productQuery: string;
  customerEmail: string;
  simulatePaymentWebhook?: boolean;
  shopDomain?: string;
};

export type SyntheticCallRunnerResult = VoiceE2EStagingReport;

function stepLatency(steps: VoiceE2EStepRecord[], step: string): number | undefined {
  const hit = steps.filter((s) => s.step === step).pop();
  return hit?.latencyMs;
}

export async function runSyntheticStagingCall(
  app: INestApplicationContext,
  opts: SyntheticCallRunnerOptions,
): Promise<SyntheticCallRunnerResult> {
  const prisma = app.get(PrismaService);
  const calls = app.get(CallsService);
  const sessionContext = app.get(SessionContextService);
  const orchestrator = app.get(RealtimeVoiceOrchestratorService);
  const trace = app.get(VoiceE2ETraceService);
  const shopify = app.get(ShopifyService);

  const errors: string[] = [];
  const flowStarted = Date.now();
  const turnLatencies: number[] = [];

  const agent = await prisma.agent.findFirst({
    where: { id: opts.agentId, tenantId: opts.tenantId, deletedAt: null },
    select: { id: true, shopifyStoreUrl: true, shopifyStoreNumber: true },
  });
  if (!agent) {
    throw new Error('Agent not found for synthetic E2E call.');
  }

  const session = await calls.createSession({
    tenantId: opts.tenantId,
    agentId: opts.agentId,
    twilioCallSid: `CA_e2e_${Date.now()}`,
    fromNumber: '+15555550100',
    toNumber: '+15555550199',
    direction: 'inbound',
  });

  const traceId = trace.startTrace(session.id, 'synthetic');
  await trace.record(session.id, 'call_connected', { ok: true, provider: 'synthetic', traceId });

  await calls.updateSessionStatus(session.id, { status: 'IN_PROGRESS' });
  const ctx = await sessionContext.load(session.id, true);
  if (!ctx) {
    throw new Error(`Failed to load session context for E2E call ${session.id}`);
  }
  await calls.mergeSessionMetadata(session.id, { e2eTraceId: traceId, e2eMode: 'synthetic' });

  const utterances = [
    opts.productQuery,
    'the first one',
    opts.customerEmail,
    'yes that is correct',
  ];

  let history: ConversationTurn[] = [];

  for (const text of utterances) {
    await trace.record(session.id, 'transcript_final', { metadata: { text: text.slice(0, 120) }, traceId });

    const turnStarted = Date.now();
    const result = await orchestrator.processUtterance(session.id, text, history);
    turnLatencies.push(result.totalLatencyMs);

    if (result.immediateFiller?.trim()) {
      await trace.record(session.id, 'filler_started', {
        metadata: { filler: result.immediateFiller.slice(0, 120) },
        traceId,
      });
    }

    history = [
      ...history,
      { role: 'user' as const, content: text },
      { role: 'assistant' as const, content: result.reply },
    ].slice(-24);
  }

  const checkoutLink = await prisma.checkoutLink.findFirst({
    where: { callSessionId: session.id, tenantId: opts.tenantId },
    orderBy: { createdAt: 'desc' },
  });

  if (!checkoutLink) {
    errors.push('checkout_link_not_created');
  } else {
    await trace.record(session.id, 'checkout_created', {
      ok: true,
      provider: 'shopify_checkout',
      metadata: { checkoutLinkId: checkoutLink.id, status: checkoutLink.status },
      traceId,
    });
  }

  const emailEvent = checkoutLink
    ? await prisma.emailEvent.findFirst({
        where: {
          callSessionId: session.id,
          checkoutLinkId: checkoutLink.id,
          recipientEmail: opts.customerEmail.toLowerCase(),
        },
        orderBy: { createdAt: 'desc' },
      })
    : null;

  const emailOk =
    emailEvent &&
    ([EmailDeliveryStatus.SENT, EmailDeliveryStatus.DELIVERED, EmailDeliveryStatus.QUEUED] as EmailDeliveryStatus[]).includes(
      emailEvent.status,
    );

  if (emailOk) {
    await trace.record(session.id, 'email_sent', {
      ok: true,
      provider: 'resend',
      metadata: { emailEventId: emailEvent!.id, status: emailEvent!.status },
      traceId,
    });
  } else if (checkoutLink) {
    errors.push('payment_email_not_delivered');
  }

  if (opts.simulatePaymentWebhook !== false && checkoutLink && opts.shopDomain) {
    const orderId = `e2e_${Date.now()}`;
    try {
      await shopify.handleWebhook('orders/updated', opts.shopDomain, {
        id: orderId,
        name: `#E2E${orderId.slice(-4)}`,
        email: opts.customerEmail,
        financial_status: 'paid',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await trace.record(session.id, 'payment_status_checked', {
        ok: true,
        provider: 'shopify_webhook',
        metadata: { orderId, simulated: true },
        traceId,
      });
    } catch (err) {
      errors.push(`webhook_simulation_failed:${(err as Error).message}`);
      await trace.record(session.id, 'payment_status_checked', {
        ok: false,
        provider: 'shopify_webhook',
        error: (err as Error).message,
        traceId,
      });
    }
  }

  const refreshedCheckout = checkoutLink
    ? await prisma.checkoutLink.findUnique({ where: { id: checkoutLink.id } })
    : null;

  await trace.record(session.id, 'call_ended', { ok: errors.length === 0, traceId });
  await calls.updateSessionStatus(session.id, {
    status: 'COMPLETED',
    endedAt: new Date(),
    metadata: { e2eCompleted: true, e2eTraceId: traceId },
  });

  const snapshot = (await trace.finishTrace(traceId))!;
  const failedStep = snapshot.steps.find((s) => s.ok === false);
  const failedProvider = failedStep?.provider ?? (errors.length ? 'staging_e2e' : undefined);

  const pass =
    errors.length === 0 &&
    Boolean(checkoutLink) &&
    Boolean(emailOk) &&
    (refreshedCheckout?.status === CheckoutLinkStatus.COMPLETED ||
      opts.simulatePaymentWebhook === false);

  return {
    pass: opts.simulatePaymentWebhook === false ? errors.length === 0 && Boolean(checkoutLink) && Boolean(emailOk) : pass,
    traceId,
    callSessionId: session.id,
    mode: 'synthetic',
    failedProvider,
    checkoutStatus: refreshedCheckout?.status ?? checkoutLink?.status ?? 'missing',
    emailDeliveryStatus: emailEvent?.status ?? 'missing',
    latency: {
      productSearchMs: stepLatency(snapshot.steps, 'product_search_completed'),
      emailVerifyMs: stepLatency(snapshot.steps, 'email_verified'),
      checkoutCreateMs: stepLatency(snapshot.steps, 'checkout_created'),
      emailSendMs: stepLatency(snapshot.steps, 'email_sent'),
      totalFlowMs: Date.now() - flowStarted,
      turnLatenciesMs: turnLatencies,
    },
    steps: snapshot.steps,
    errors,
  };
}
