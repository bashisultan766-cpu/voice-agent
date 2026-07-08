/**
 * Voice adapter — static boot-time provider selection (single process-wide engine).
 * Probes ElevenLabs once at startup; on auth/quota/timeout/5xx failure locks OpenAI for life.
 */
import { getConfig } from "../config.js";
import { logger } from "../utils/logger.js";

export type PreferredVoiceEngine = "ElevenLabs" | "openai-tts-1-hd";

export type GlobalVoiceProvider = "ElevenLabs" | "OpenAI";

export type MediaStreamEngineName =
  | "ElevenLabs"
  | "OpenAI tts-1-hd"
  | "Media Streams (ElevenLabs)"
  | "Media Streams (OpenAI fallback)";

export type ElevenLabsFailureReason =
  | "auth_failed"
  | "quota_exceeded"
  | "server_error"
  | "timeout"
  | "network_error"
  | "probe_http_error"
  | "stream_crash"
  | "elevenlabs_not_configured";

export interface ElevenLabsCircuitSnapshot {
  open: boolean;
  primaryEngine: "ElevenLabs";
  activeProvider: GlobalVoiceProvider | null;
  failoverReason: ElevenLabsFailureReason | null;
  trippedAt: number | null;
  lastHttpStatus: number | null;
}

export const ELEVENLABS_CIRCUIT_BREAKER_LOG =
  "ELEVENLABS CIRCUIT BREAKER: Quota exceeded. Routing to OpenAI for the duration of this process.";

const ELEVENLABS_PROBE_TIMEOUT_MS = 8000;

const CIRCUIT_TRIP_REASONS = new Set<ElevenLabsFailureReason>([
  "auth_failed",
  "quota_exceeded",
  "server_error",
  "timeout",
  "network_error",
  "probe_http_error",
  "stream_crash",
]);

/** Process-wide static provider — set once during initializeGlobalVoiceProvider(). */
let globalVoiceProvider: GlobalVoiceProvider | null = null;
let initPromise: Promise<GlobalVoiceProvider> | null = null;

/** @deprecated Use globalVoiceProvider === "OpenAI" via getIsElevenLabsDisabled(). */
let isElevenLabsDisabled = false;

let circuitTrippedAt: number | null = null;
let failoverReason: ElevenLabsFailureReason | null = null;
let lastHttpStatus: number | null = null;

export function getGlobalVoiceProvider(): GlobalVoiceProvider | null {
  return globalVoiceProvider;
}

export function isVoiceProviderReady(): boolean {
  return globalVoiceProvider !== null;
}

export function getIsElevenLabsDisabled(): boolean {
  return globalVoiceProvider !== "ElevenLabs";
}

export function getElevenLabsCircuitSnapshot(): ElevenLabsCircuitSnapshot {
  return {
    open: getIsElevenLabsDisabled(),
    primaryEngine: "ElevenLabs",
    activeProvider: globalVoiceProvider,
    failoverReason,
    trippedAt: circuitTrippedAt,
    lastHttpStatus,
  };
}

/** @internal Test helper — resets process-wide voice provider state. */
export function resetElevenLabsCircuitBreakerForTests(): void {
  globalVoiceProvider = null;
  initPromise = null;
  isElevenLabsDisabled = false;
  circuitTrippedAt = null;
  failoverReason = null;
  lastHttpStatus = null;
}

export function tripElevenLabsCircuitBreaker(
  reason?: ElevenLabsFailureReason,
  status?: number,
): void {
  if (globalVoiceProvider === "OpenAI") return;

  globalVoiceProvider = "OpenAI";
  isElevenLabsDisabled = true;
  circuitTrippedAt = Date.now();

  if (reason) {
    failoverReason = reason;
  }
  if (status !== undefined) {
    lastHttpStatus = status;
  }

  if (reason !== undefined || status !== undefined) {
    logger.warn(ELEVENLABS_CIRCUIT_BREAKER_LOG, {
      reason: reason ?? failoverReason,
      status,
    });
  } else {
    logger.warn(ELEVENLABS_CIRCUIT_BREAKER_LOG);
  }
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

export function isElevenLabsAuthError(status: number): boolean {
  return status === 401 || status === 403;
}

export function isElevenLabsQuotaError(status: number): boolean {
  return status === 429;
}

export function isElevenLabsServerError(status: number): boolean {
  return status >= 500 && status < 600;
}

export function classifyElevenLabsHttpStatus(status: number): ElevenLabsFailureReason {
  if (isElevenLabsAuthError(status)) return "auth_failed";
  if (isElevenLabsQuotaError(status)) return "quota_exceeded";
  if (isElevenLabsServerError(status)) return "server_error";
  return "probe_http_error";
}

/**
 * Unified failure reporter — logs, classifies, and trips the circuit when appropriate.
 * All ElevenLabs failures from ttsAdapter and boot probe must route through here.
 */
export function recordElevenLabsFailure(
  reason: ElevenLabsFailureReason,
  options?: { status?: number; callSid?: string },
): void {
  if (options?.status !== undefined) {
    lastHttpStatus = options.status;
  }

  logger.warn("elevenlabs_failure_recorded", {
    reason,
    status: options?.status,
    callSid: options?.callSid?.slice(0, 8),
    circuitAlreadyOpen: globalVoiceProvider === "OpenAI",
  });

  if (CIRCUIT_TRIP_REASONS.has(reason)) {
    tripElevenLabsCircuitBreaker(reason, options?.status);
  }
}

/** @deprecated Use recordElevenLabsFailure("auth_failed", { callSid }). */
export function markElevenLabsAuthFailure(callSid?: string): void {
  recordElevenLabsFailure("auth_failed", { callSid });
}

/** @deprecated Per-call voice overrides removed — provider is process-wide static. */
export function clearPreferredVoiceForCall(_callSid: string): void {
  // no-op
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
  reason: ElevenLabsFailureReason | "authenticated";
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

    return {
      ok: false,
      reason: classifyElevenLabsHttpStatus(res.status),
      status: res.status,
    };
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
      failoverReason = "elevenlabs_not_configured";
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
      const failureReason = probe.reason as ElevenLabsFailureReason;
      recordElevenLabsFailure(failureReason, { status: probe.status });
    }

    logVoiceEngineSelection();
    return globalVoiceProvider!;
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

/** Resolve which engine synthesizes live Media Streams audio. */
export function getMediaStreamTtsEngine(): MediaStreamEngineName {
  if (getIsElevenLabsDisabled()) {
    return "Media Streams (OpenAI fallback)";
  }
  const voiceId = getLockedElevenLabsVoiceId();
  if (getConfig().VOICE_TTS_PROVIDER.toLowerCase() === "elevenlabs" && voiceId) {
    return "Media Streams (ElevenLabs)";
  }
  return "Media Streams (OpenAI fallback)";
}

/** Logs static boot-time engine selection — safe to call once after init. */
export function logVoiceEngineSelection(engine?: MediaStreamEngineName): void {
  const name = engine ?? getMediaStreamTtsEngine();
  const provider = globalVoiceProvider ?? (getIsElevenLabsDisabled() ? "OpenAI" : "ElevenLabs");
  logger.info("voice_engine_selected", {
    engine: name,
    provider,
    openAiVoice: provider === "OpenAI" ? getOpenAiEricFallbackVoice() : undefined,
    elevenLabsVoiceId: provider === "ElevenLabs" ? getLockedElevenLabsVoiceId() || undefined : undefined,
  });
}
