import type { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentsService } from '../../modules/agents/agents.service';
import { TwilioConnectionTestService } from '../../modules/agents/connection-test/twilio-connection-test.service';
import { OpenAIConnectionTestService } from '../../modules/agents/connection-test/openai-connection-test.service';
import { ElevenLabsConnectionTestService } from '../../modules/agents/connection-test/elevenlabs-connection-test.service';
import { OpenAiRealtimeBridge } from '../../modules/realtime-voice/media-stream/openai-realtime-bridge';
import { OpenAiRealtimeBridgeService } from '../../modules/realtime-voice/media-stream/openai-realtime-bridge.service';
import {
  isFullDuplexVoiceEnabled,
  isGatherFallbackEnabled,
  isOpenAiRealtimeEnabled,
  isVoiceMediaStreamEnabled,
} from '../../modules/realtime-voice/config/realtime-voice-flags.util';
import { normalizePublicWebhookBaseUrl } from '../../common/public-webhook-base-url';
import { loadAgentCredentialContext } from './client-demo-agent-credentials';
import type { ClientDemoCheck, ClientDemoVoiceValidation } from './client-demo.types';

function basicAuth(sid: string, token: string): string {
  return `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
}

export async function placeTwilioTestCall(opts: {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  timeoutSec?: number;
}): Promise<{ callSid: string; status: string }> {
  const body = new URLSearchParams({
    From: opts.from,
    To: opts.to,
    Timeout: String(Math.min(Math.max(opts.timeoutSec ?? 30, 10), 120)),
  });

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(opts.accountSid)}/Calls.json`,
    {
      method: 'POST',
      headers: {
        Authorization: basicAuth(opts.accountSid, opts.authToken),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    },
  );

  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Twilio Calls API ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { sid?: string; status?: string };
  if (!data.sid) throw new Error('Twilio did not return a Call SID.');
  return { callSid: data.sid, status: data.status ?? 'queued' };
}

export async function pollTwilioCallStatus(opts: {
  accountSid: string;
  authToken: string;
  callSid: string;
  maxMs?: number;
  intervalMs?: number;
}): Promise<string> {
  const maxMs = opts.maxMs ?? 45_000;
  const intervalMs = opts.intervalMs ?? 2000;
  const deadline = Date.now() + maxMs;

  while (Date.now() < deadline) {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(opts.accountSid)}/Calls/${encodeURIComponent(opts.callSid)}.json`,
      {
        headers: { Authorization: basicAuth(opts.accountSid, opts.authToken) },
      },
    );
    if (res.ok) {
      const data = (await res.json()) as { status?: string };
      const status = (data.status ?? '').toLowerCase();
      if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(status)) {
        return status;
      }
      if (['in-progress', 'ringing', 'answered'].includes(status)) {
        return status;
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return 'timeout';
}

async function probeMediaStreamEndpoint(baseUrl: string): Promise<ClientDemoCheck> {
  const started = Date.now();
  const wsPath = '/api/realtime-voice/media-stream';
  const httpUrl = `${baseUrl.replace(/\/$/, '')}${wsPath}`;
  try {
    const res = await fetch(httpUrl, { method: 'GET', redirect: 'manual' });
    const latencyMs = Date.now() - started;
    // WebSocket upgrade endpoints often return 400/426/404 on plain GET — any response proves routing
    const pass = res.status > 0 && res.status !== 502 && res.status !== 503;
    return {
      key: 'media_stream_endpoint_reachable',
      pass,
      details: `GET ${httpUrl} → HTTP ${res.status}`,
      latencyMs,
      fix: pass ? undefined : 'Ensure API is deployed and PUBLIC_WEBHOOK_BASE_URL routes to this service.',
    };
  } catch (err) {
    return {
      key: 'media_stream_endpoint_reachable',
      pass: false,
      details: (err as Error).message,
      fix: 'Set PUBLIC_WEBHOOK_BASE_URL to your public HTTPS API origin.',
    };
  }
}

export async function runVoiceProbes(
  app: INestApplicationContext,
  tenantId: string,
  agentId: string,
  opts?: { placeLiveCall?: boolean; callFrom?: string; callTo?: string },
): Promise<ClientDemoVoiceValidation> {
  const errors: string[] = [];
  const checks: ClientDemoCheck[] = [];
  const agents = app.get(AgentsService);
  const twilioTest = app.get(TwilioConnectionTestService);
  const openaiTest = app.get(OpenAIConnectionTestService);
  const elevenTest = app.get(ElevenLabsConnectionTestService);
  const config = app.get(ConfigService);
  const bridgeService = app.get(OpenAiRealtimeBridgeService);

  const creds = await loadAgentCredentialContext(app, tenantId, agentId);
  const twilioResolved = creds.twilio;
  const openaiResolved = creds.openai;
  const elevenResolved = creds.elevenlabs;
  const agentRow = creds.agent;

  let twilioConnected = false;
  let twilioWebhookVerified = false;

  if (twilioResolved) {
    const tw = await twilioTest.testConnection({
      twilioAccountSid: twilioResolved.accountSid,
      twilioAuthToken: twilioResolved.authToken,
      twilioPhoneNumber: twilioResolved.phoneNumber,
    });
    twilioConnected = tw.success;
    checks.push({
      key: 'twilio_api_connected',
      pass: tw.success,
      details: tw.message,
    });

    if (twilioResolved.phoneNumber) {
      const phoneCfg = await twilioTest.getIncomingPhoneNumberConfig({
        twilioAccountSid: twilioResolved.accountSid,
        twilioAuthToken: twilioResolved.authToken,
        twilioPhoneNumber: twilioResolved.phoneNumber,
      });
      const readiness = await agents.getAgentReadiness(tenantId, agentId);
      const expectedInbound = readiness.expectedTwilioWebhookUrls?.inbound ?? '';
      twilioWebhookVerified =
        Boolean(phoneCfg) &&
        (phoneCfg?.voiceUrl ?? '').replace(/\/$/, '') === expectedInbound.replace(/\/$/, '');
      checks.push({
        key: 'twilio_inbound_webhook',
        pass: twilioWebhookVerified,
        details: phoneCfg?.voiceUrl ?? 'no phone config',
        fix: 'Run Configure Twilio Webhook from the agent dashboard.',
      });
    }
  } else {
    errors.push('twilio_credentials_missing');
    checks.push({ key: 'twilio_api_connected', pass: false, details: 'Twilio credentials missing' });
  }

  let openAiRealtimeConnected = false;
  if (openaiResolved?.apiKey) {
    const oa = await openaiTest.testConnection({ openaiApiKey: openaiResolved.apiKey });
    checks.push({ key: 'openai_api_connected', pass: oa.success, details: oa.message });

    if (isOpenAiRealtimeEnabled()) {
      const started = Date.now();
      try {
        const bridge = new OpenAiRealtimeBridge(
          { apiKey: openaiResolved.apiKey, model: bridgeService.resolveModel() },
          { onFinalTranscript: () => undefined },
        );
        await bridge.connect();
        bridge.close();
        openAiRealtimeConnected = true;
        checks.push({
          key: 'openai_realtime_ws',
          pass: true,
          details: 'WebSocket session opened to OpenAI Realtime API',
          latencyMs: Date.now() - started,
        });
      } catch (err) {
        errors.push(`openai_realtime_failed:${(err as Error).message}`);
        checks.push({
          key: 'openai_realtime_ws',
          pass: false,
          details: (err as Error).message,
        });
      }
    } else {
      checks.push({
        key: 'openai_realtime_ws',
        pass: true,
        details: 'OPENAI_REALTIME_ENABLED=false (Gather MVP path)',
      });
    }
  } else {
    errors.push('openai_credentials_missing');
  }

  let elevenLabsStreaming = false;
  if (elevenResolved?.apiKey) {
    const el = await elevenTest.testConnection({
      elevenlabsApiKey: elevenResolved.apiKey,
      voiceId: elevenResolved.voiceId,
      tenantId,
    });
    elevenLabsStreaming = el.success;
    checks.push({ key: 'elevenlabs_tts', pass: el.success, details: el.message });
  } else if ((agentRow?.voiceProvider ?? '').toLowerCase() !== 'elevenlabs') {
    elevenLabsStreaming = true;
    checks.push({ key: 'elevenlabs_tts', pass: true, details: 'Agent not using ElevenLabs voice provider' });
  } else {
    errors.push('elevenlabs_credentials_missing');
  }

  const baseUrl = normalizePublicWebhookBaseUrl(config.get<string>('PUBLIC_WEBHOOK_BASE_URL'));
  let mediaStreamReady = false;
  if (baseUrl && isVoiceMediaStreamEnabled()) {
    const probe = await probeMediaStreamEndpoint(baseUrl);
    checks.push(probe);
    mediaStreamReady = probe.pass;
  } else {
    checks.push({
      key: 'media_stream_endpoint_reachable',
      pass: !isVoiceMediaStreamEnabled(),
      details: isVoiceMediaStreamEnabled()
        ? 'VOICE_MEDIA_STREAM_ENABLED but no PUBLIC_WEBHOOK_BASE_URL'
        : 'Media stream disabled (Gather MVP)',
    });
    mediaStreamReady = !isVoiceMediaStreamEnabled();
  }

  const gatherFallbackEnabled = isGatherFallbackEnabled();
  checks.push({
    key: 'gather_fallback_enabled',
    pass: gatherFallbackEnabled,
    details: `GATHER_FALLBACK_ENABLED=${process.env.GATHER_FALLBACK_ENABLED ?? 'true'}`,
    fix: gatherFallbackEnabled ? undefined : 'Set GATHER_FALLBACK_ENABLED=true for realtime failure recovery.',
  });

  checks.push({
    key: 'full_duplex_flags',
    pass: isFullDuplexVoiceEnabled() || !isOpenAiRealtimeEnabled(),
    details: `full_duplex=${isFullDuplexVoiceEnabled()}, media_stream=${isVoiceMediaStreamEnabled()}, realtime=${isOpenAiRealtimeEnabled()}`,
  });

  const bargeInReady = isFullDuplexVoiceEnabled() && gatherFallbackEnabled;
  checks.push({
    key: 'barge_in_pipeline_ready',
    pass: bargeInReady || !isFullDuplexVoiceEnabled(),
    details: bargeInReady
      ? 'Full-duplex + Gather fallback configured (barge-in handled in media-stream pipeline)'
      : 'Gather MVP uses speech barge-in via Twilio Gather',
  });

  let liveCallPlaced = false;
  let callSid: string | undefined;
  let callStatus: string | undefined;

  if (
    opts?.placeLiveCall &&
    twilioResolved &&
    opts.callFrom?.trim() &&
    opts.callTo?.trim()
  ) {
    try {
      const placed = await placeTwilioTestCall({
        accountSid: twilioResolved.accountSid,
        authToken: twilioResolved.authToken,
        from: opts.callFrom.trim(),
        to: opts.callTo.trim(),
        timeoutSec: Number(process.env.CLIENT_DEMO_CALL_TIMEOUT_SEC) || 25,
      });
      callSid = placed.callSid;
      callStatus = await pollTwilioCallStatus({
        accountSid: twilioResolved.accountSid,
        authToken: twilioResolved.authToken,
        callSid: placed.callSid,
        maxMs: Number(process.env.CLIENT_DEMO_CALL_POLL_MS) || 40_000,
      });
      liveCallPlaced = ['in-progress', 'ringing', 'answered', 'completed'].includes(callStatus);
      checks.push({
        key: 'twilio_live_call',
        pass: liveCallPlaced,
        details: `CallSid=${callSid} status=${callStatus}`,
      });
      if (!liveCallPlaced) errors.push(`twilio_call_${callStatus}`);
    } catch (err) {
      errors.push(`twilio_live_call_failed:${(err as Error).message}`);
      checks.push({
        key: 'twilio_live_call',
        pass: false,
        details: (err as Error).message,
      });
    }
  }

  const pass =
    twilioConnected &&
    twilioWebhookVerified &&
    (openAiRealtimeConnected || !isOpenAiRealtimeEnabled()) &&
    elevenLabsStreaming &&
    mediaStreamReady &&
    gatherFallbackEnabled &&
    errors.length === 0;

  return {
    pass,
    twilioConnected,
    twilioWebhookVerified,
    mediaStreamReady,
    openAiRealtimeConnected,
    elevenLabsStreaming,
    gatherFallbackEnabled,
    liveCallPlaced,
    callSid,
    callStatus,
    bargeInReady,
    checks,
    errors,
  };
}
