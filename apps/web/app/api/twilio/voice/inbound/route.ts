import { deprecatedVoicePipelineResponse } from '@/lib/twilio/deprecated-voice-pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** DEPRECATED — Twilio voice webhooks moved to services/voice-agent POST /voice/incoming */
export async function POST() {
  return deprecatedVoicePipelineResponse();
}
