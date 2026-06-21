import { NextResponse } from 'next/server';

export const DEPRECATED_VOICE_PIPELINE_MESSAGE =
  'Deprecated: use services/voice-agent Media Streams pipeline';

export function deprecatedVoicePipelineResponse(): NextResponse {
  return new NextResponse(DEPRECATED_VOICE_PIPELINE_MESSAGE, {
    status: 410,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
