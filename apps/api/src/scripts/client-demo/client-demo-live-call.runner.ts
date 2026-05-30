import type { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { runSyntheticStagingCall } from '../../modules/realtime-voice/e2e/synthetic-call-runner';
import { runClientDemoReadiness } from './client-demo-readiness.runner';
import { runVoiceProbes } from './client-demo-voice-probes';
import { loadAgentCredentialContext } from './client-demo-agent-credentials';
import type { ClientDemoReport } from './client-demo.types';

function shopDomainFromUrl(url: string | null | undefined): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
    return host.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0]?.replace(/^www\./, '');
  }
}

export async function runClientDemoLiveCallTest(
  app: INestApplicationContext,
  opts: {
    tenantId: string;
    agentId: string;
    productQuery: string;
    isbnQuery?: string;
    customerEmail: string;
    callFrom?: string;
    callTo?: string;
    runSyntheticCommerce?: boolean;
    skipReadiness?: boolean;
  },
): Promise<ClientDemoReport> {
  const providerErrors: string[] = [];
  const creds = await loadAgentCredentialContext(app, opts.tenantId, opts.agentId);

  const callFrom =
    opts.callFrom?.trim() ||
    process.env.CLIENT_DEMO_CALL_FROM?.trim() ||
    creds.twilio?.phoneNumber?.trim();
  const callTo =
    opts.callTo?.trim() ||
    process.env.CLIENT_DEMO_CALL_TO?.trim() ||
    creds.agent.twilioPhoneNumber?.trim();

  let baseReport: ClientDemoReport;
  if (opts.skipReadiness) {
    baseReport = {
      generatedAt: new Date().toISOString(),
      pass: false,
      mode: 'live-call',
      tenantId: opts.tenantId,
      agentId: opts.agentId,
      paymentSafety: {
        pass: true,
        stagingMode: true,
        productionMode: false,
        emailAllowlistConfigured: false,
        shopifyTestCheckoutRequired: true,
        realCardBlockedInStaging: true,
        checks: [],
      },
      readinessChecks: [],
      latency: {},
      providerErrors: [],
    };
  } else {
    baseReport = await runClientDemoReadiness(app, {
      tenantId: opts.tenantId,
      agentId: opts.agentId,
      productQuery: opts.productQuery,
      isbnQuery: opts.isbnQuery,
      customerEmail: opts.customerEmail,
      skipEmailSend: process.env.CLIENT_DEMO_SKIP_EMAIL === 'true',
    });
  }

  const voiceLive = await runVoiceProbes(app, opts.tenantId, opts.agentId, {
    placeLiveCall: Boolean(callFrom && callTo),
    callFrom,
    callTo,
  });

  let callSessionId: string | undefined;
  let traceId = baseReport.traceId;
  let callResult: ClientDemoReport['callResult'] = voiceLive.liveCallPlaced ? 'connected' : 'failed';

  if (!voiceLive.liveCallPlaced && callFrom && callTo) {
    providerErrors.push('live_twilio_call_did_not_connect');
    callResult = 'failed';
  } else if (!callFrom || !callTo) {
    callResult = 'skipped';
    providerErrors.push('CLIENT_DEMO_CALL_FROM and CLIENT_DEMO_CALL_TO (or agent Twilio number) required for live call');
  }

  if (voiceLive.callSid) {
    const prisma = app.get(PrismaService);
    const deadline = Date.now() + (Number(process.env.CLIENT_DEMO_SESSION_POLL_MS) || 30_000);
    while (Date.now() < deadline) {
      const session = await prisma.callSession.findFirst({
        where: { twilioCallSid: voiceLive.callSid, tenantId: opts.tenantId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, metadata: true },
      });
      if (session) {
        callSessionId = session.id;
        const meta = session.metadata as Record<string, unknown> | null;
        if (typeof meta?.e2eTraceId === 'string') traceId = meta.e2eTraceId;
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!callSessionId) {
      providerErrors.push('call_session_not_created_for_live_call');
    }
  }

  let syntheticLatency = baseReport.latency;
  if (opts.runSyntheticCommerce !== false && process.env.CLIENT_DEMO_SKIP_SYNTHETIC !== 'true') {
    const prisma = app.get(PrismaService);
    const agent = await prisma.agent.findFirst({
      where: { id: opts.agentId, tenantId: opts.tenantId },
      select: { shopifyStoreUrl: true },
    });
    const shopDomain =
      process.env.E2E_SHOP_DOMAIN?.trim() ??
      shopDomainFromUrl(agent?.shopifyStoreUrl ?? undefined);

    try {
      const e2e = await runSyntheticStagingCall(app, {
        tenantId: opts.tenantId,
        agentId: opts.agentId,
        productQuery: opts.productQuery,
        customerEmail: opts.customerEmail,
        simulatePaymentWebhook: false,
        shopDomain,
      });
      traceId = e2e.traceId;
      callSessionId = e2e.callSessionId;
      syntheticLatency = {
        ...syntheticLatency,
        productSearchMs: e2e.latency.productSearchMs,
        checkoutCreateMs: e2e.latency.checkoutCreateMs,
        emailSendMs: e2e.latency.emailSendMs,
        totalFlowMs: e2e.latency.totalFlowMs,
        turnLatenciesMs: e2e.latency.turnLatenciesMs,
      };
      if (!e2e.pass) providerErrors.push(...e2e.errors);
    } catch (err) {
      providerErrors.push(`synthetic_commerce_failed:${(err as Error).message}`);
    }
  }

  const voice = {
    ...baseReport.voice!,
    ...voiceLive,
    callSessionId,
  };

  const pass = baseReport.pass && voice.pass && callResult !== 'failed' && providerErrors.length === 0;

  return {
    ...baseReport,
    generatedAt: new Date().toISOString(),
    pass,
    mode: 'live-call',
    traceId,
    callResult,
    voice,
    latency: {
      ...syntheticLatency,
      callConnectMs: voice.checks.find((c) => c.key === 'twilio_live_call')?.latencyMs,
    },
    providerErrors: [...new Set([...baseReport.providerErrors, ...providerErrors, ...voice.errors])],
  };
}
