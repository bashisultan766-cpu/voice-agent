/** Per-turn metadata: at most one ElevenLabs REST API call per caller utterance. */
export const VOICE_TTS_TURN_META = {
  apiCallUsed: 'ttsApiCallUsedThisTurn',
  turnStartedAtMs: 'ttsTurnStartedAtMs',
  lastVoiceText: 'lastVoiceText',
} as const;

export function resetTtsTurnGuardPatch(): Record<string, unknown> {
  return {
    [VOICE_TTS_TURN_META.apiCallUsed]: false,
    [VOICE_TTS_TURN_META.turnStartedAtMs]: Date.now(),
    [VOICE_TTS_TURN_META.lastVoiceText]: null,
  };
}

export function readTtsTurnGuard(metadata: Record<string, unknown> | null | undefined): {
  apiCallUsed: boolean;
} {
  if (!metadata || typeof metadata !== 'object') {
    return { apiCallUsed: false };
  }
  return { apiCallUsed: metadata[VOICE_TTS_TURN_META.apiCallUsed] === true };
}

export function markTtsApiCallUsedPatch(voiceText: string): Record<string, unknown> {
  return {
    [VOICE_TTS_TURN_META.apiCallUsed]: true,
    [VOICE_TTS_TURN_META.lastVoiceText]: voiceText,
  };
}

export function canMakeElevenLabsApiCall(args: {
  metadata: Record<string, unknown> | null | undefined;
  isOrchestratorFinalReply?: boolean;
  cacheHit: boolean;
}): boolean {
  if (args.cacheHit) return false;
  if (!args.isOrchestratorFinalReply) return false;
  return !readTtsTurnGuard(args.metadata).apiCallUsed;
}
