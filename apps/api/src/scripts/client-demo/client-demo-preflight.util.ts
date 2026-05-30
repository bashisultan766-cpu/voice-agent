import Redis from 'ioredis';
import {
  createRedisClient,
  normalizeRedisUrl,
  REDIS_CLIENT_OPTIONS,
} from '../../common/redis-client.util';
import { isFullDuplexVoiceEnabled } from '../../modules/realtime-voice/config/realtime-voice-flags.util';
import type { ClientDemoCheck } from './client-demo.types';
import { buildPaymentSafetyChecks } from './client-demo-safety.util';

export async function runClientDemoPreflight(env: NodeJS.ProcessEnv): Promise<{
  ok: boolean;
  checks: ClientDemoCheck[];
}> {
  const checks: ClientDemoCheck[] = [];

  const required = [
    'DEV_TENANT_ID',
    'DEV_AGENT_ID',
    'DATABASE_URL',
    'DEV_TEST_CUSTOMER_EMAIL',
    'PUBLIC_WEBHOOK_BASE_URL',
  ];
  for (const key of required) {
    checks.push({
      key: `env_${key.toLowerCase()}`,
      pass: Boolean(env[key]?.trim()),
      details: env[key]?.trim() ? 'set' : 'missing',
      fix: env[key]?.trim() ? undefined : `Set ${key} for client demo.`,
    });
  }

  if (isFullDuplexVoiceEnabled()) {
    checks.push({
      key: 'env_redis_url',
      pass: Boolean(env.REDIS_URL?.trim()),
      details: env.REDIS_URL?.trim() ? 'set' : 'missing',
      fix: 'Set REDIS_URL when full-duplex realtime voice is enabled.',
    });
  }

  const providerHints = [
    ['TWILIO_AUTH_TOKEN', 'twilio_env_hint'],
    ['OPENAI_API_KEY', 'openai_env_hint'],
    ['ELEVENLABS_API_KEY', 'elevenlabs_env_hint'],
    ['RESEND_API_KEY', 'resend_env_hint'],
  ] as const;
  for (const [envKey, checkKey] of providerHints) {
    checks.push({
      key: checkKey,
      pass: true,
      details: env[envKey]?.trim()
        ? `${envKey} set (agent/workspace credentials preferred in production)`
        : 'use per-agent credentials',
    });
  }

  const redisUrl = normalizeRedisUrl(env.REDIS_URL);
  if (redisUrl && isFullDuplexVoiceEnabled()) {
    const client = new Redis(redisUrl, {
      ...REDIS_CLIENT_OPTIONS,
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
    });
    try {
      const pong = await client.ping();
      checks.push({ key: 'redis_ping', pass: pong === 'PONG', details: `PING ${pong}` });
    } catch (err) {
      checks.push({
        key: 'redis_ping',
        pass: false,
        details: (err as Error).message,
        fix: 'Ensure Redis is reachable from the API host.',
      });
    } finally {
      client.disconnect();
    }
  }

  const payment = buildPaymentSafetyChecks();
  checks.push(...payment.checks);

  const requiredKeys = new Set([
    'env_dev_tenant_id',
    'env_dev_agent_id',
    'env_database_url',
    'env_dev_test_customer_email',
    'env_public_webhook_base_url',
    'email_allowlist_when_staging',
    'staging_mode_declared',
  ]);
  if (isFullDuplexVoiceEnabled()) {
    requiredKeys.add('env_redis_url');
    requiredKeys.add('redis_ping');
  }

  const ok = checks.filter((c) => requiredKeys.has(c.key)).every((c) => c.pass);
  return { ok, checks };
}
