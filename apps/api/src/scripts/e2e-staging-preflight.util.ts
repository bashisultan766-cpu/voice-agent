import Redis from 'ioredis';
import {
  createRedisClient,
  normalizeRedisUrl,
  REDIS_CLIENT_OPTIONS,
} from '../common/redis-client.util';
import { isFullDuplexVoiceEnabled } from '../modules/realtime-voice/config/realtime-voice-flags.util';

export type PreflightCheck = { key: string; pass: boolean; details: string; fix?: string };

export async function runStagingPreflight(env: NodeJS.ProcessEnv): Promise<{
  ok: boolean;
  checks: PreflightCheck[];
}> {
  const checks: PreflightCheck[] = [];

  const required = [
    'DEV_TENANT_ID',
    'DEV_AGENT_ID',
    'DATABASE_URL',
    'REDIS_URL',
    'DEV_TEST_CUSTOMER_EMAIL',
  ];
  for (const key of required) {
    checks.push({
      key: `env_${key.toLowerCase()}`,
      pass: Boolean(env[key]?.trim()),
      details: env[key]?.trim() ? 'set' : 'missing',
      fix: env[key]?.trim() ? undefined : `Set ${key} in staging environment.`,
    });
  }

  checks.push({
    key: 'realtime_multi_agent_enabled',
    pass: env.REALTIME_MULTI_AGENT_ENABLED === 'true',
    details: env.REALTIME_MULTI_AGENT_ENABLED ?? 'false',
    fix: 'Set REALTIME_MULTI_AGENT_ENABLED=true for staging E2E.',
  });

  checks.push({
    key: 'full_duplex_flags',
    pass: isFullDuplexVoiceEnabled(),
    details: `VOICE_MEDIA_STREAM=${env.VOICE_MEDIA_STREAM_ENABLED}, OPENAI_REALTIME=${env.OPENAI_REALTIME_ENABLED}`,
    fix: 'Enable VOICE_MEDIA_STREAM_ENABLED, OPENAI_REALTIME_ENABLED, REALTIME_MULTI_AGENT_ENABLED.',
  });

  const providerHints = [
    ['TWILIO_ACCOUNT_SID', 'twilio_configured'],
    ['OPENAI_API_KEY', 'openai_configured'],
    ['ELEVENLABS_API_KEY', 'elevenlabs_configured'],
    ['RESEND_API_KEY', 'resend_configured'],
    ['PUBLIC_WEBHOOK_BASE_URL', 'public_webhook_url'],
  ] as const;
  for (const [envKey, checkKey] of providerHints) {
    checks.push({
      key: checkKey,
      pass: Boolean(env[envKey]?.trim()),
      details: env[envKey]?.trim() ? 'configured' : 'optional/missing',
    });
  }

  const redisUrl = normalizeRedisUrl(env.REDIS_URL);
  if (redisUrl) {
    const client = new Redis(redisUrl, { ...REDIS_CLIENT_OPTIONS, maxRetriesPerRequest: 1, connectTimeout: 1500 });
    try {
      const pong = await client.ping();
      checks.push({ key: 'redis_ping', pass: pong === 'PONG', details: `PING ${pong}` });
    } catch (err) {
      checks.push({
        key: 'redis_ping',
        pass: false,
        details: (err as Error).message,
        fix: 'Ensure Redis is reachable from staging API.',
      });
    } finally {
      client.disconnect();
    }
  }

  const requiredKeys = new Set([
    'env_dev_tenant_id',
    'env_dev_agent_id',
    'env_database_url',
    'env_redis_url',
    'env_dev_test_customer_email',
    'realtime_multi_agent_enabled',
    'redis_ping',
  ]);
  const ok = checks.filter((c) => requiredKeys.has(c.key)).every((c) => c.pass);

  return { ok, checks };
}

export function printProductionReadinessReport(report: {
  pass: boolean;
  preflight: { ok: boolean; checks: PreflightCheck[] };
  e2e?: { pass: boolean; traceId: string; latency: Record<string, unknown> };
}): void {
  console.log('\n=== Realtime Voice Staging — Production Readiness Report ===\n');
  console.log(JSON.stringify(report, null, 2));
  console.log('\n--- Summary ---');
  console.log(`Preflight: ${report.preflight.ok ? 'PASS' : 'FAIL'}`);
  if (report.e2e) {
    console.log(`E2E synthetic call: ${report.e2e.pass ? 'PASS' : 'FAIL'}`);
    console.log(`Trace ID: ${report.e2e.traceId}`);
  }
  console.log(`Overall: ${report.pass ? 'PASS' : 'FAIL'}\n`);
}
