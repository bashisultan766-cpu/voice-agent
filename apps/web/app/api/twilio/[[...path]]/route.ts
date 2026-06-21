import { deprecatedVoicePipelineResponse } from '@/lib/twilio/deprecated-voice-pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** DEPRECATED — Twilio voice proxy retired; point Twilio at services/voice-agent */
export async function GET() {
  return deprecatedVoicePipelineResponse();
}

export async function POST() {
  return deprecatedVoicePipelineResponse();
}
