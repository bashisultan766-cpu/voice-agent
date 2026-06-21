import { deprecatedVoicePipelineResponse } from '@/lib/twilio/deprecated-voice-pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** DEPRECATED — use services/voice-agent Media Streams pipeline */
export async function POST() {
  return deprecatedVoicePipelineResponse();
}
