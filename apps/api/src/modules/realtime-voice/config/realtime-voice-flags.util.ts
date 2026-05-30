/**
 * Runtime flags for full-duplex Twilio Media Streams + OpenAI Realtime.
 * Accepts common truthy/falsey env forms (true, TRUE, 1, yes, on).
 */

export type RealtimePipelineFlags = {
  voiceMediaStream: boolean;
  openaiRealtime: boolean;
  multiAgent: boolean;
  elevenlabsStreaming: boolean;
  gatherFallback: boolean;
  fullDuplex: boolean;
  legacyMediaStream: boolean;
};

export type InboundVoicePipelinePath = 'full_duplex' | 'legacy_media_stream' | 'gather_mvp';

export function readEnvFlag(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[key];
  if (raw === undefined || raw === null) return false;
  const v = String(raw).trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off' || v === '') return false;
  return false;
}

/** Enabled unless explicitly set to false (0, no, off). */
export function readEnvFlagOptOut(
  key: string,
  defaultEnabled = true,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultEnabled;
  const v = String(raw).trim().toLowerCase();
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  return defaultEnabled;
}

export function getRealtimePipelineFlags(env: NodeJS.ProcessEnv = process.env): RealtimePipelineFlags {
  const voiceMediaStream = readEnvFlag('VOICE_MEDIA_STREAM_ENABLED', env);
  const openaiRealtime = readEnvFlag('OPENAI_REALTIME_ENABLED', env);
  const multiAgent = readEnvFlag('REALTIME_MULTI_AGENT_ENABLED', env);
  const fullDuplex = voiceMediaStream && openaiRealtime && multiAgent;
  return {
    voiceMediaStream,
    openaiRealtime,
    multiAgent,
    elevenlabsStreaming: readEnvFlagOptOut('ELEVENLABS_STREAMING_TTS_ENABLED', true, env),
    gatherFallback: readEnvFlagOptOut('GATHER_FALLBACK_ENABLED', true, env),
    fullDuplex,
    legacyMediaStream: voiceMediaStream && !fullDuplex && !openaiRealtime,
  };
}

/** Full-duplex: Twilio Media Streams + OpenAI Realtime STT + multi-agent + ElevenLabs WS TTS. */
export function isFullDuplexVoiceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getRealtimePipelineFlags(env).fullDuplex;
}

export function isVoiceMediaStreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readEnvFlag('VOICE_MEDIA_STREAM_ENABLED', env);
}

export function isOpenAiRealtimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readEnvFlag('OPENAI_REALTIME_ENABLED', env);
}

export function isRealtimeMultiAgentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readEnvFlag('REALTIME_MULTI_AGENT_ENABLED', env);
}

export function isElevenLabsStreamingTtsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readEnvFlagOptOut('ELEVENLABS_STREAMING_TTS_ENABLED', true, env);
}

export function isGatherFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readEnvFlagOptOut('GATHER_FALLBACK_ENABLED', true, env);
}

/** Legacy experimental path at /api/twilio/voice/media-stream (no OpenAI Realtime bridge). */
export function isLegacyMediaStreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flags = getRealtimePipelineFlags(env);
  return flags.legacyMediaStream;
}

export function resolveInboundVoicePipelinePath(env: NodeJS.ProcessEnv = process.env): InboundVoicePipelinePath {
  if (isFullDuplexVoiceEnabled(env)) return 'full_duplex';
  if (isLegacyMediaStreamEnabled(env) || isVoiceMediaStreamEnabled(env)) return 'legacy_media_stream';
  return 'gather_mvp';
}
