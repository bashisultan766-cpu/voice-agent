/** Production voice commerce latency profile (VOICE_COMMERCE_FAST_MODE=true). */
export function isVoiceCommerceFastMode(): boolean {
  const raw = (process.env.VOICE_COMMERCE_FAST_MODE ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** Play search filler when deferred job exceeds this (ms). */
export function voiceSearchFillerThresholdMs(): number {
  const raw = Number(process.env.VOICE_SEARCH_FILLER_THRESHOLD_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1500;
}

/** Twilio deferred-poll pause between hops (seconds). */
export function voiceDeferredPollPauseSeconds(): number {
  if (!isVoiceCommerceFastMode()) return 1;
  const raw = Number(process.env.VOICE_DEFERRED_POLL_PAUSE_SEC);
  return Number.isFinite(raw) && raw > 0 ? Math.min(2, raw) : 0.5;
}

/** Shopify GraphQL `first` cap per attempt in fast mode. */
export function voiceShopifySearchFirst(): number {
  if (!isVoiceCommerceFastMode()) return 25;
  const raw = Number(process.env.VOICE_SHOPIFY_SEARCH_FIRST);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(25, Math.trunc(raw)) : 12;
}

/** Max parallel Shopify query attempts in fast mode. */
export function voiceShopifyMaxAttempts(attemptCount: number): number {
  if (!isVoiceCommerceFastMode()) return attemptCount;
  const cap = Number(process.env.VOICE_SHOPIFY_MAX_ATTEMPTS);
  const max = Number.isFinite(cap) && cap >= 1 ? Math.trunc(cap) : 3;
  return Math.min(attemptCount, max);
}

/** OpenAI max_tokens for voice turns in fast mode. */
export function voiceLlmMaxTokens(defaultTokens: number): number {
  if (!isVoiceCommerceFastMode()) return defaultTokens;
  const raw = Number(process.env.VOICE_FAST_MODE_MAX_TOKENS);
  return Number.isFinite(raw) && raw >= 80 ? Math.trunc(raw) : 280;
}

/** Tool loop cap when fast mode is on (still respects MAX_TOOL_ITERATIONS_VOICE). */
export function voiceFastModeMaxToolIterations(defaultMax: number): number {
  if (!isVoiceCommerceFastMode()) return defaultMax;
  const raw = Number(process.env.VOICE_FAST_MODE_MAX_TOOL_ITERATIONS);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(defaultMax, Math.trunc(raw)) : Math.min(defaultMax, 4);
}

export function voiceFastModeParallelToolCalls(): boolean {
  return isVoiceCommerceFastMode();
}
