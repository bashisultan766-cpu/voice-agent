/**
 * Central voice playback policy — ElevenLabs-only vs Twilio Say fallback.
 */

export type VoiceProviderPolicy = {
  forceElevenLabsOnly: boolean;
  forceTwilioFallback: boolean;
  /** When true, TwiML must not use &lt;Say&gt; (Play or silent redirect only). */
  twilioSayBlocked: boolean;
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
  };
}

export function buildVoiceProviderEnforcedLog(policy: VoiceProviderPolicy): Record<string, unknown> {
  return {
    event: 'voice_provider_enforced',
    provider: 'elevenlabs',
    forceElevenLabsOnly: policy.forceElevenLabsOnly,
    twilioSayBlocked: policy.twilioSayBlocked,
    forceTwilioFallback: policy.forceTwilioFallback,
  };
}

/** Deferred search fillers use a second voice when played via Twilio Say — skip when EL-only. */
export function shouldPlayDeferredSearchFiller(policy: VoiceProviderPolicy): boolean {
  return !policy.twilioSayBlocked;
}
