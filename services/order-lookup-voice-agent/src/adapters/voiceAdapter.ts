/**
 * Voice adapter — static boot-time provider selection (single process-wide engine).
 * Probes ElevenLabs once at startup; on auth/quota/timeout failure locks OpenAI for life.
 */
import {
  getConfig,
  conversationRelayVoice,
  normalizeTwilioElevenLabsModel,
  formatTwilioVoiceTuning,
} from "../config.js";
import { logger } from "../utils/logger.js";

export type PreferredVoiceEngine = "ElevenLabs" | "openai-tts-1-hd";

export type GlobalVoiceProvider = "ElevenLabs" | "OpenAI";

export type VoiceRelayEngineName =
  | "ElevenLabs"
  | "OpenAI tts-1-hd"
  | "Twilio ConversationRelay (ElevenLabs)"
  | "Twilio ConversationRelay (OpenAI fallback)";

export const ELEVENLABS_CIRCUIT_BREAKER_LOG =
  "ELEVENLABS CIRCUIT BREAKER: Quota exceeded. Routing to OpenAI for the duration of this process.";

const ELEVENLABS_PROBE_TIMEOUT_MS = 8000;

/** Process-wide static provider — set once during initializeGlobalVoiceProvider(). */
let globalVoiceProvider: GlobalVoiceProvider | null = null;
let initPromise: Promise<GlobalVoiceProvider> | null = null;

/** @deprecated Use globalVoiceProvider === "OpenAI" via getIsElevenLabsDisabled(). */
let isElevenLabsDisabled = false;

export function getGlobalVoiceProvider(): GlobalVoiceProvider | null {
  return globalVoiceProvider;
}

export function isVoiceProviderReady(): boolean {
  return globalVoiceProvider !== null;
}

export function getIsElevenLabsDisabled(): boolean {
  return globalVoiceProvider !== "ElevenLabs";
}

/** @internal Test helper — resets process-wide voice provider state. */
export function resetElevenLabsCircuitBreakerForTests(): void {
  globalVoiceProvider = null;
  initPromise = null;
  isElevenLabsDisabled = false;
}

export function tripElevenLabsCircuitBreaker(): void {
  if (globalVoiceProvider === "OpenAI") return;
  globalVoiceProvider = "OpenAI";
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

export function getPreferredVoiceForCall(_callSid?: string): PreferredVoiceEngine {
  if (globalVoiceProvider === "OpenAI" || isElevenLabsDisabled) {
    return "openai-tts-1-hd";
  }
  return "ElevenLabs";
}

/** Permanent runtime trip — no retry back to ElevenLabs once quota/auth is confirmed. */
export function markElevenLabsAuthFailure(_callSid?: string): void {
  tripElevenLabsCircuitBreaker();
}

/** @deprecated Per-call voice overrides removed — provider is process-wide static. */
export function clearPreferredVoiceForCall(_callSid: string): void {
  // no-op
}

export function isElevenLabsAuthError(status: number): boolean {
  return status === 401 || status === 403;
}

function shouldAttemptElevenLabsAtBoot(): boolean {
  const cfg = getConfig();
  const voiceId = getLockedElevenLabsVoiceId();
  return (
    cfg.VOICE_TTS_PROVIDER.toLowerCase() === "elevenlabs" &&
    Boolean(cfg.ELEVENLABS_API_KEY?.trim()) &&
    Boolean(voiceId)
  );
}

async function probeElevenLabsOnce(): Promise<{
  ok: boolean;
  reason: string;
  status?: number;
}> {
  const cfg = getConfig();
  const apiKey = cfg.ELEVENLABS_API_KEY?.trim() ?? "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ELEVENLABS_PROBE_TIMEOUT_MS);

  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user", {
      method: "GET",
      headers: { "xi-api-key": apiKey },
      signal: controller.signal,
    });

    if (res.ok) {
      return { ok: true, reason: "authenticated" };
    }

    if (isElevenLabsAuthError(res.status)) {
      return { ok: false, reason: "auth_failed", status: res.status };
    }

    return { ok: false, reason: "probe_http_error", status: res.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout =
      err instanceof Error &&
      (err.name === "AbortError" || /aborted|timeout/i.test(message));
    return { ok: false, reason: isTimeout ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Boot-time static voice provider selection — call exactly once before accepting calls.
 * Never re-probes ElevenLabs after this resolves.
 */
export async function initializeGlobalVoiceProvider(): Promise<GlobalVoiceProvider> {
  if (globalVoiceProvider !== null) {
    return globalVoiceProvider;
  }
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async (): Promise<GlobalVoiceProvider> => {
    if (!shouldAttemptElevenLabsAtBoot()) {
      globalVoiceProvider = "OpenAI";
      isElevenLabsDisabled = true;
      logger.info("voice_provider_static_openai", {
        reason: "elevenlabs_not_configured",
      });
      logVoiceEngineSelection();
      return globalVoiceProvider;
    }

    const probe = await probeElevenLabsOnce();
    if (probe.ok) {
      globalVoiceProvider = "ElevenLabs";
      isElevenLabsDisabled = false;
      logger.info("voice_provider_static_elevenlabs", { reason: probe.reason });
    } else {
      globalVoiceProvider = "OpenAI";
      isElevenLabsDisabled = true;
      if (probe.reason === "auth_failed" || probe.reason === "timeout") {
        logger.warn(ELEVENLABS_CIRCUIT_BREAKER_LOG, {
          reason: probe.reason,
          status: probe.status,
        });
      } else {
        logger.warn("voice_provider_static_openai", {
          reason: probe.reason,
          status: probe.status,
        });
      }
    }

    logVoiceEngineSelection();
    return globalVoiceProvider;
  })();

  return initPromise;
}

export function ensureVoiceProviderReady():
  | { ok: true; provider: GlobalVoiceProvider }
  | { ok: false; error: string } {
  if (globalVoiceProvider === null) {
    return { ok: false, error: "voice_provider_not_initialized" };
  }
  return { ok: true, provider: globalVoiceProvider };
}

/** Resolve which engine handles live ConversationRelay TTS (Twilio-side synthesis). */
export function getConversationRelayTtsEngine(): VoiceRelayEngineName {
  if (getIsElevenLabsDisabled()) {
    return "Twilio ConversationRelay (OpenAI fallback)";
  }
  const voiceId = getLockedElevenLabsVoiceId();
  if (getConfig().VOICE_TTS_PROVIDER.toLowerCase() === "elevenlabs" && voiceId) {
    return "Twilio ConversationRelay (ElevenLabs)";
  }
  return "Twilio ConversationRelay (OpenAI fallback)";
}

/** Twilio ConversationRelay voice attrs — locked to static boot-time provider. */
export function buildConversationRelayVoiceAttrs(): Record<string, string> {
  const cfg = getConfig();
  const attrs: Record<string, string> = {
    language: cfg.VOICE_LANGUAGE,
    interruptible: "true",
    dtmfDetection: "true",
  };

  const useElevenLabs = globalVoiceProvider === "ElevenLabs";

  if (useElevenLabs) {
    attrs.ttsProvider = "ElevenLabs";
    attrs.voice = conversationRelayVoice();
    attrs.elevenlabsTextNormalization = cfg.ELEVENLABS_TEXT_NORMALIZATION;
  } else {
    attrs.voice = buildOpenAiRelayVoiceSlug();
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

/** Logs static boot-time engine selection — safe to call once after init. */
export function logVoiceEngineSelection(engine?: VoiceRelayEngineName): void {
  const name = engine ?? getConversationRelayTtsEngine();
  const provider = globalVoiceProvider ?? (getIsElevenLabsDisabled() ? "OpenAI" : "ElevenLabs");
  logger.info("voice_engine_selected", {
    engine: name,
    provider,
    openAiVoice: provider === "OpenAI" ? getOpenAiEricFallbackVoice() : undefined,
    elevenLabsVoiceId: provider === "ElevenLabs" ? getLockedElevenLabsVoiceId() || undefined : undefined,
  });
}
