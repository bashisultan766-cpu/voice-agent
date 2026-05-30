/** Full-duplex: Twilio Media Streams + OpenAI Realtime STT + multi-agent + ElevenLabs WS TTS. */
export function isFullDuplexVoiceEnabled(): boolean {
  return (
    process.env.VOICE_MEDIA_STREAM_ENABLED === 'true' &&
    process.env.OPENAI_REALTIME_ENABLED === 'true' &&
    process.env.REALTIME_MULTI_AGENT_ENABLED === 'true'
  );
}

export function isVoiceMediaStreamEnabled(): boolean {
  return process.env.VOICE_MEDIA_STREAM_ENABLED === 'true';
}

export function isOpenAiRealtimeEnabled(): boolean {
  return process.env.OPENAI_REALTIME_ENABLED === 'true';
}

export function isElevenLabsStreamingTtsEnabled(): boolean {
  return process.env.ELEVENLABS_STREAMING_TTS_ENABLED !== 'false';
}

export function isGatherFallbackEnabled(): boolean {
  return process.env.GATHER_FALLBACK_ENABLED !== 'false';
}

/** Legacy experimental path at /api/twilio/voice/media-stream (no OpenAI Realtime bridge). */
export function isLegacyMediaStreamEnabled(): boolean {
  return (
    isVoiceMediaStreamEnabled() &&
    !isFullDuplexVoiceEnabled() &&
    process.env.OPENAI_REALTIME_ENABLED !== 'true'
  );
}
