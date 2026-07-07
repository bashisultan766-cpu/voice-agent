/**
 * Voice adapter — single entry point for voice engine selection and TTS routing.
 * Locks ElevenLabs to env VOICE_ID; on quota failure routes to OpenAI Eric-matched fallback.
 */
import { getConfig, conversationRelayVoice, normalizeTwilioElevenLabsModel, formatTwilioVoiceTuning } from "../config.js";
import { logger } from "../utils/logger.js";

export type PreferredVoiceEngine = "ElevenLabs" | "openai-tts-1-hd";

export type VoiceRelayEngineName =
  | "ElevenLabs"
  | "OpenAI tts-1-hd"
  | "Twilio ConversationRelay (ElevenLabs)"
  | "Twilio ConversationRelay (OpenAI fallback)";

export const ELEVENLABS_CIRCUIT_BREAKER_LOG =
  "ELEVENLABS CIRCUIT BREAKER: Quota exceeded. Routing to OpenAI for the duration of this process.";

/** Process-wide circuit breaker — trips on ElevenLabs 401/403 and skips all further EL calls. */
let isElevenLabsDisabled = false;

const preferredVoiceByCall = new Map<string, PreferredVoiceEngine>();
const authFailureLogged = new Set<string>();

export function getIsElevenLabsDisabled(): boolean {
  return isElevenLabsDisabled;
}

/** @internal Test helper — resets process-wide circuit breaker state. */
export function resetElevenLabsCircuitBreakerForTests(): void {
  isElevenLabsDisabled = false;
  preferredVoiceByCall.clear();
  authFailureLogged.clear();
}

export function tripElevenLabsCircuitBreaker(): void {
  if (isElevenLabsDisabled) return;
  isElevenLabsDisabled = true;
  logger.warn(ELEVENLABS_CIRCUIT_BREAKER_LOG);
}

/** ElevenLabs voice ID locked from environment — never invented at runtime. */
export function getLockedElevenLabsVoiceId(): string {
  const cfg = getConfig();
  return (cfg.VOICE_ID || cfg.ELEVENLABS_VOICE_ID || "").trim();
}

/** OpenAI tts-1-hd voice tuned to approximate the Eric ElevenLabs profile. */
export function getOpenAiEricFallbackVoice(): string {
  return getConfig().OPENAI_TTS_VOICE;
}

export function getPreferredVoiceForCall(callSid?: string): PreferredVoiceEngine {
  if (isElevenLabsDisabled) return "openai-tts-1-hd";
  if (!callSid) return "ElevenLabs";
  return preferredVoiceByCall.get(callSid) ?? "ElevenLabs";
}

export function markElevenLabsAuthFailure(callSid?: string): void {
  tripElevenLabsCircuitBreaker();
  if (callSid) {
    preferredVoiceByCall.set(callSid, "openai-tts-1-hd");
    if (!authFailureLogged.has(callSid)) {
      authFailureLogged.add(callSid);
      logger.info("tts_voice_fallback_locked", {
        callSid: callSid.slice(0, 8),
        preferredVoice: "openai-tts-1-hd",
        openAiVoice: getOpenAiEricFallbackVoice(),
      });
    }
  }
}

export function clearPreferredVoiceForCall(callSid: string): void {
  preferredVoiceByCall.delete(callSid);
  authFailureLogged.delete(callSid);
}

export function isElevenLabsAuthError(status: number): boolean {
  return status === 401 || status === 403;
}

/** Resolve which engine handles live ConversationRelay TTS (Twilio-side synthesis). */
export function getConversationRelayTtsEngine(): VoiceRelayEngineName {
  if (isElevenLabsDisabled) {
    return "Twilio ConversationRelay (OpenAI fallback)";
  }
  const voiceId = getLockedElevenLabsVoiceId();
  if (getConfig().VOICE_TTS_PROVIDER.toLowerCase() === "elevenlabs" && voiceId) {
    return "Twilio ConversationRelay (ElevenLabs)";
  }
  return "Twilio ConversationRelay (OpenAI fallback)";
}

/** Twilio ConversationRelay voice attrs — ElevenLabs locked to env, OpenAI on circuit trip. */
export function buildConversationRelayVoiceAttrs(): Record<string, string> {
  const cfg = getConfig();
  const attrs: Record<string, string> = {
    language: cfg.VOICE_LANGUAGE,
    interruptible: "true",
    dtmfDetection: "true",
  };

  const voiceId = getLockedElevenLabsVoiceId();
  const useElevenLabs =
    !isElevenLabsDisabled && cfg.VOICE_TTS_PROVIDER.toLowerCase() === "elevenlabs" && Boolean(voiceId);

  if (useElevenLabs) {
    attrs.ttsProvider = "ElevenLabs";
    attrs.voice = conversationRelayVoice();
    attrs.elevenlabsTextNormalization = cfg.ELEVENLABS_TEXT_NORMALIZATION;
  } else if (isElevenLabsDisabled) {
    attrs.voice = buildOpenAiRelayVoiceSlug();
  } else {
    attrs.voice = conversationRelayVoice();
  }

  return attrs;
}

/** Relay voice slug when OpenAI fallback is active — uses locked Eric tuning, not a random system voice. */
function buildOpenAiRelayVoiceSlug(): string {
  const cfg = getConfig();
  const voiceId = getLockedElevenLabsVoiceId();
  if (!voiceId) {
    return `openai-${getOpenAiEricFallbackVoice()}`;
  }

  const model = normalizeTwilioElevenLabsModel(cfg.VOICE_MODEL);
  if (!model) return voiceId;

  if (!cfg.VOICE_TUNING_ENABLED) {
    return `${voiceId}-${model}`;
  }

  const tuning = formatTwilioVoiceTuning(cfg.VOICE_SPEED, cfg.VOICE_STABILITY, cfg.VOICE_SIMILARITY);
  return `${voiceId}-${model}-${tuning}`;
}

export function logVoiceEngineSelection(engine?: VoiceRelayEngineName): void {
  const name = engine ?? getConversationRelayTtsEngine();
  logger.info("voice_engine_selected", {
    engine: name,
    openAiVoice: isElevenLabsDisabled ? getOpenAiEricFallbackVoice() : undefined,
    elevenLabsVoiceId: isElevenLabsDisabled ? undefined : getLockedElevenLabsVoiceId() || undefined,
  });
}
