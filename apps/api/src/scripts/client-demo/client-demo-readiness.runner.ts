import type { INestApplicationContext } from '@nestjs/common';
import { AgentsService } from '../../modules/agents/agents.service';
import { VoiceE2ETraceService } from '../../modules/realtime-voice/observability/voice-e2e-trace.service';
import { runClientDemoPreflight } from './client-demo-preflight.util';
import { buildPaymentSafetyChecks } from './client-demo-safety.util';
import { validateShopifyProducts } from './client-demo-shopify-validation';
import { validatePaymentEmailDelivery } from './client-demo-email-validation';
import { runVoiceProbes } from './client-demo-voice-probes';
import type { ClientDemoCheck, ClientDemoReport } from './client-demo.types';

function readinessChecksFromAgent(
  readiness: Awaited<ReturnType<AgentsService['getAgentReadiness']>>,
): ClientDemoCheck[] {
  return (readiness.checks ?? []).map((c) => ({
    key: c.key,
    pass: c.pass,
    details: c.label,
    fix: c.fixAction,
  }));
}

export async function runClientDemoReadiness(
  app: INestApplicationContext,
  opts: {
    tenantId: string;
    agentId: string;
    productQuery: string;
    isbnQuery?: string;
    customerEmail: string;
    skipEmailSend?: boolean;
  },
): Promise<ClientDemoReport> {
  const started = Date.now();
  const providerErrors: string[] = [];
  const agents = app.get(AgentsService);
  const traceService = app.get(VoiceE2ETraceService);

  const preflight = await runClientDemoPreflight(process.env);
  if (!preflight.ok) {
    providerErrors.push('preflight_failed');
  }

  const readiness = await agents.getAgentReadiness(opts.tenantId, opts.agentId);
  const readinessChecks = readinessChecksFromAgent(readiness);
  if (!readiness.ready) {
    providerErrors.push(...(readiness.failures ?? []).map((f) => `readiness:${f}`));
  }

  const paymentSafety = buildPaymentSafetyChecks();

  const product = await validateShopifyProducts(app, opts.tenantId, opts.agentId, {
    productQuery: opts.productQuery,
    isbnQuery: opts.isbnQuery,
    customerEmail: opts.customerEmail,
    createCheckout: true,
  });
  if (!product.pass) providerErrors.push(...product.errors);

  let email;
  if (!opts.skipEmailSend && product.checkoutLinkId) {
    email = await validatePaymentEmailDelivery(app, opts.tenantId, opts.agentId, {
      recipient: opts.customerEmail,
      checkoutLinkId: product.checkoutLinkId,
      skipSend: false,
    });
    if (!email.pass) providerErrors.push(...email.errors);
  } else {
    email = {
      pass: true,
      recipient: opts.customerEmail,
      allowlistEnforced: paymentSafety.emailAllowlistConfigured,
      emailSent: false,
      resendVerified: false,
      errors: opts.skipEmailSend ? [] : ['checkout_link_missing_for_email_test'],
    };
    if (!opts.skipEmailSend && !product.checkoutLinkId) {
      email.pass = false;
    }
  }

  const voice = await runVoiceProbes(app, opts.tenantId, opts.agentId, {
    placeLiveCall: false,
  });
  if (!voice.pass) providerErrors.push(...voice.errors);

  const traceId = traceService.startTrace(`client-demo-readiness-${Date.now()}`, 'synthetic');
  traceService.finishTrace(traceId).catch(() => undefined);

  const pass =
    preflight.ok &&
    readiness.ready &&
    paymentSafety.pass &&
    product.pass &&
    email.pass &&
    voice.pass &&
    providerErrors.length === 0;

  return {
    generatedAt: new Date().toISOString(),
    pass,
    mode: 'readiness',
    tenantId: opts.tenantId,
    agentId: opts.agentId,
    traceId,
    callResult: 'skipped',
    product,
    email,
    voice,
    paymentSafety,
    readinessChecks,
    latency: {
      productSearchMs: product.searchLatencyMs,
      checkoutCreateMs: product.checkoutLatencyMs,
      emailSendMs: email.sendLatencyMs,
      emailDeliveryMs: email.deliveryLatencyMs,
      totalFlowMs: Date.now() - started,
    },
    providerErrors: [...new Set(providerErrors)],
    preflight,
  };
}
