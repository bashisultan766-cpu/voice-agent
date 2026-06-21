import { deprecatedVoicePipelineResponse } from '@/lib/twilio/deprecated-voice-pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** DEPRECATED — gather/deferred-poll pipeline retired */
export async function POST() {
  return deprecatedVoicePipelineResponse();
}
