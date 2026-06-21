import { deprecatedVoicePipelineResponse } from '@/lib/twilio/deprecated-voice-pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** DEPRECATED — legacy gather TTS playback */
export async function GET() {
  return deprecatedVoicePipelineResponse();
}
