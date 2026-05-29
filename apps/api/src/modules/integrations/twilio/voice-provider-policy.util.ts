/**
 * Central voice playback policy — ElevenLabs-only vs Twilio Say fallback.
 */

export type VoiceProviderActuallyUsed = 'elevenlabs' | 'elevenlabs_silent_wait' | 'twilio_say_fallback';

export type VoicePlaybackLogKind = 'elevenlabs_audio' | 'silent_wait' | 'twilio_say';

export type VoiceProviderPolicy = {
  forceElevenLabsOnly: boolean;
  forceTwilioFallback: boolean;
  /** When true, TwiML must not use &lt;Say&gt; (Play or silent redirect only). */
  twilioSayBlocked: boolean;
  /** Hard lock: no Twilio TTS when FORCE_ELEVENLABS_ONLY or STRICT_ELEVENLABS_ONLY (unless escape hatch). */
  disableTwilioSayCompletely: boolean;
};

function parseEnvBool(raw: string | undefined, defaultValue = false): boolean {
  const v = `${raw ?? ''}`.trim().toLowerCase();
  if (!v) return defaultValue;
  return v === '1' || v === 'true' || v === 'yes';
}

export function resolveVoiceProviderPolicy(env: {
  FORCE_ELEVENLABS_ONLY?: string;
  STRICT_ELEVENLABS_ONLY?: string;
  FORCE_TWILIO_FALLBACK?: string;
} = {}): VoiceProviderPolicy {
  const forceElevenLabsOnly = parseEnvBool(env.FORCE_ELEVENLABS_ONLY);
  const strictElevenLabsOnly = parseEnvBool(env.STRICT_ELEVENLABS_ONLY, true);
  const forceTwilioFallback = parseEnvBool(env.FORCE_TWILIO_FALLBACK);
  const elevenLabsOnlyMode =
    (forceElevenLabsOnly || strictElevenLabsOnly) && !forceTwilioFallback;

  return {
    forceElevenLabsOnly: forceElevenLabsOnly || strictElevenLabsOnly,
    forceTwilioFallback,
    twilioSayBlocked: elevenLabsOnlyMode,
    disableTwilioSayCompletely: elevenLabsOnlyMode,
  };
}

export function buildVoiceProviderEnforcedLog(policy: VoiceProviderPolicy): Record<string, unknown> {
  return {
    event: 'voice_provider_enforced',
    provider: 'elevenlabs',
    forceElevenLabsOnly: policy.forceElevenLabsOnly,
    twilioSayBlocked: policy.twilioSayBlocked,
    disableTwilioSayCompletely: policy.disableTwilioSayCompletely,
    forceTwilioFallback: policy.forceTwilioFallback,
  };
}

export function buildElevenLabsOnlyModeActiveLog(policy: VoiceProviderPolicy): Record<string, unknown> {
  return {
    event: 'voice.elevenlabs_only_mode_active',
    forceElevenLabsOnly: policy.forceElevenLabsOnly,
    disableTwilioSayCompletely: policy.disableTwilioSayCompletely,
    twilioSayBlocked: policy.twilioSayBlocked,
  };
}

export function buildTwilioSayBlockedLog(entry: {
  route: string;
  reason: string;
}): Record<string, unknown> {
  return {
    event: 'voice.twilio_say_blocked',
    route: entry.route,
    reason: entry.reason,
  };
}

/** Deferred search fillers use a second voice when played via Twilio Say — skip when EL-only. */
export function shouldPlayDeferredSearchFiller(policy: VoiceProviderPolicy): boolean {
  return !policy.twilioSayBlocked;
}

export function resolveVoiceProviderActuallyUsed(
  hasElevenLabsPlayback: boolean,
  policy: VoiceProviderPolicy,
): VoiceProviderActuallyUsed {
  if (hasElevenLabsPlayback) return 'elevenlabs';
  if (policy.twilioSayBlocked) return 'elevenlabs_silent_wait';
  return 'twilio_say_fallback';
}

export function resolvePlaybackLogKind(
  hasElevenLabsPlayback: boolean,
  policy: VoiceProviderPolicy,
): VoicePlaybackLogKind {
  if (hasElevenLabsPlayback) return 'elevenlabs_audio';
  if (policy.twilioSayBlocked) return 'silent_wait';
  return 'twilio_say';
}

export function resolvePlaybackChannel(
  hasElevenLabsPlayback: boolean,
  policy: VoiceProviderPolicy,
): 'elevenlabs' | 'silent_wait' | 'twilio_say' {
  if (hasElevenLabsPlayback) return 'elevenlabs';
  if (policy.twilioSayBlocked) return 'silent_wait';
  return 'twilio_say';
}

/**
 * Runtime guard: ElevenLabs-only mode must never emit Twilio &lt;Say&gt;.
 */
export function assertNoTwilioSayInTwiml(twiml: string, policy: VoiceProviderPolicy): void {
  if (!policy.twilioSayBlocked) return;
  if (/<\s*Say\b/i.test(twiml)) {
    throw new Error('Twilio SAY blocked in ElevenLabs-only mode');
  }
}

export function twimlContainsSay(twiml: string): boolean {
  return /<\s*Say\b/i.test(twiml);
}
