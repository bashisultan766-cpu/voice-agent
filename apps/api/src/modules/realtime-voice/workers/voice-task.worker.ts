/**
 * Standalone BullMQ worker for voice background tasks.
 * Run: node dist/modules/realtime-voice/workers/voice-task.worker.js
 */
import 'dotenv/config';
import { Worker } from 'bullmq';
import { normalizeRedisUrl } from '../../../common/redis-client.util';

const connection = normalizeRedisUrl(process.env.REDIS_URL);
if (!connection) {
  console.error('[voice-worker] REDIS_URL required');
  process.exit(1);
}

const worker = new Worker(
  'voice-background-tasks',
  async (job) => {
    console.log(
      JSON.stringify({
        event: 'voice.worker.job',
        name: job.name,
        id: job.id,
        data: job.data,
      }),
    );
    switch (job.name) {
      case 'post-turn':
      case 'catalog-warm':
      case 'email-retry':
      case 'analytics-flush':
        return { ok: true };
      default:
        return { ok: false, reason: 'unknown_job' };
    }
  },
  { connection: { url: connection }, concurrency: 5 },
);

worker.on('failed', (job, err) => {
  console.error(JSON.stringify({ event: 'voice.worker.failed', jobId: job?.id, error: err.message }));
});

console.log('[voice-worker] listening on voice-background-tasks');
