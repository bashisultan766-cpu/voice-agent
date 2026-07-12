import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { logger } from "./utils/logger.js";
import { normalizeShopifyEnvAliases } from "./platform/envAliases.js";

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: resolve(serviceRoot, ".env") });

const envSchema = z.object({
  PORT: z.coerce.number().default(8001),
  PUBLIC_BASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  VALIDATE_TWILIO_SIGNATURES: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  CONVERSATION_BRAIN_MODEL: z.string().default("gpt-4o"),
  OPENAI_TIMEOUT_MS: z.coerce.number().default(8000),

  SHOPIFY_SHOP_DOMAIN: z.string().min(1),
  /** Static Custom App Admin API token (required). */
  SHOPIFY_ADMIN_ACCESS_TOKEN: z.string().min(1),
  SHOPIFY_API_VERSION: z.string().default("2025-07"),
  /** Hard ceiling for Shopify HTTP / GraphQL calls (voice must not hang). */
  SHOPIFY_TIMEOUT_MS: z.coerce.number().default(6000),
  /** Hard ceiling for any UnifiedToolRegistry execution (Shopify, Resend, etc.). */
  TOOL_EXECUTION_TIMEOUT_MS: z.coerce.number().default(6000),
  SHOPIFY_CACHE_TTL_SECS: z.coerce.number().default(60),

  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  VOICE_ID: z.string().optional(),
  /** Twilio ConversationRelay model slug (e.g. turbo_v2_5). ElevenLabs API prefixes (eleven_*) are stripped automatically. */
  VOICE_MODEL: z.string().default("turbo_v2_5"),
  /** Twilio ConversationRelay tuning — speed 0.7–1.2, stability/similarity/style 0.0–1.0 */
  VOICE_SPEED: z.coerce.number().min(0.7).max(1.2).default(0.92),
  /** Studio-quality default — prevents wavering / distant tone on phone lines. */
  VOICE_STABILITY: z.coerce.number().min(0).max(1).default(0.7),
  /** Studio-quality default — strict cloned-voice fidelity. */
  VOICE_SIMILARITY: z.coerce.number().min(0).max(1).default(0.85),
  /** ElevenLabs direct API only — keep at 0 for consistent telephony clarity. */
  VOICE_STYLE: z.coerce.number().min(0).max(1).default(0),
  /** Native telephony format for direct TTS streams (Twilio mulaw 8 kHz). */
  TTS_AUDIO_FORMAT: z.enum(["ulaw_8000", "pcm_16000", "mp3_44100_128"]).default("ulaw_8000"),
  VOICE_TUNING_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Twilio ConversationRelay — improves pronunciation (slight latency tradeoff). */
  ELEVENLABS_TEXT_NORMALIZATION: z.enum(["on", "off", "auto"]).default("on"),
  VOICE_LANGUAGE: z.string().default("en-US"),
  VOICE_TTS_PROVIDER: z.string().default("ElevenLabs"),
  /** When true, skip all ElevenLabs probes/calls and lock OpenAI fallback for production. */
  VOICE_IDENTITY_CONSTRAINT: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** OpenAI tts-1-hd voice when ElevenLabs quota is exceeded — tuned to match Eric profile. */
  OPENAI_TTS_VOICE: z
    .enum(["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"])
    .default("onyx"),

  /**
   * twilio_conversation_relay — Eric voice via VOICE_ID only (Twilio synthesizes; no ElevenLabs API key).
   * twilio_media_streams — direct ElevenLabs/OpenAI TTS over Media Streams (requires API key).
   */
  VOICE_RUNTIME: z
    .enum(["twilio_conversation_relay", "twilio_media_streams"])
    .default("twilio_conversation_relay"),

  ORDER_LOOKUP_MAX_RETRIES: z.coerce.number().default(2),
  VOICE_ROUTER_FORWARD_SECRET: z.string().optional(),
  VOICE_CHUNK_MAX_PAUSE_MS: z.coerce.number().default(120),

  SAFE_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().email().optional(),
  RESEND_FROM_NAME: z.string().default("SureShot Books"),
  SUPPORT_EMAIL: z.string().email().default("jessica@sureshotbooks.com"),
});

function trimStrings<T extends Record<string, unknown>>(obj: T): T {
  const out = { ...obj };
  for (const key of Object.keys(out)) {
    const val = out[key];
    if (typeof val === "string") {
      (out as Record<string, unknown>)[key] = val.trim();
    }
  }
  return out;
}

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | null = null;
let warnedNonElevenLabsProvider = false;

/** @internal Test helper — clears memoized config between test cases. */
export function resetConfigCacheForTests(): void {
  cached = null;
  warnedNonElevenLabsProvider = false;
}

export function getConfig(): AppConfig {
  if (!cached) {
    normalizeShopifyEnvAliases();
    const parsed = envSchema.safeParse(trimStrings(process.env as Record<string, unknown>));
    if (!parsed.success) {
      const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid environment configuration: ${missing}`);
    }

    const data = parsed.data;
    if (!data.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim()) {
      throw new Error(
        "Invalid environment configuration: SHOPIFY_ADMIN_ACCESS_TOKEN is required",
      );
    }

    cached = data;

    if (
      !warnedNonElevenLabsProvider &&
      !cached.VOICE_IDENTITY_CONSTRAINT &&
      cached.VOICE_TTS_PROVIDER.toLowerCase() !== "elevenlabs"
    ) {
      warnedNonElevenLabsProvider = true;
      logger.warn("voice_tts_provider_not_elevenlabs", {
        configured: cached.VOICE_TTS_PROVIDER,
        expected: "ElevenLabs",
        message:
          "ElevenLabs is the primary voice identity; non-ElevenLabs provider forces OpenAI fallback.",
      });
    }
  }
  return cached;
}

export function normalizeTwilioElevenLabsModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return "";

  const aliases: Record<string, string> = {
    eleven_flash_v2_5: "flash_v2_5",
    eleven_flash_v2: "flash_v2",
    eleven_turbo_v2_5: "turbo_v2_5",
    eleven_turbo_v2: "turbo_v2",
    eleven_multilingual_v2: "multilingual_v2",
  };

  if (aliases[trimmed]) return aliases[trimmed];
  if (trimmed.startsWith("eleven_")) return trimmed.slice("eleven_".length);
  return trimmed;
}

export function formatTwilioVoiceTuning(speed: number, stability: number, similarity: number): string {
  const fmt = (n: number) => {
    const rounded = Math.round(n * 100) / 100;
    return Number.isInteger(rounded) ? `${rounded}.0` : String(rounded);
  };
  return `${fmt(speed)}_${fmt(stability)}_${fmt(similarity)}`;
}

export function conversationRelayVoice(): string {
  const cfg = getConfig();
  const voiceId = (cfg.VOICE_ID || cfg.ELEVENLABS_VOICE_ID || "").trim();
  if (cfg.VOICE_TTS_PROVIDER.toLowerCase() !== "elevenlabs" || !voiceId) {
    return "Google.en-US-Neural2-J";
  }

  const model = normalizeTwilioElevenLabsModel(cfg.VOICE_MODEL);
  if (!model) return voiceId;

  if (!cfg.VOICE_TUNING_ENABLED) {
    return `${voiceId}-${model}`;
  }

  const tuning = formatTwilioVoiceTuning(cfg.VOICE_SPEED, cfg.VOICE_STABILITY, cfg.VOICE_SIMILARITY);
  return `${voiceId}-${model}-${tuning}`;
}

export function wsUrl(): string {
  const base = getConfig().PUBLIC_BASE_URL.replace(/^http/, "ws").replace(/\/$/, "");
  return `${base}${CONVERSATION_BRAIN_PATH_PREFIX}/ws`;
}

/** True when Twilio ConversationRelay handles STT/TTS — only VOICE_ID required. */
export function isConversationRelayRuntime(): boolean {
  return getConfig().VOICE_RUNTIME === "twilio_conversation_relay";
}

/** Twilio ConversationRelay paths under the conversation brain namespace. */
export const CONVERSATION_BRAIN_PATH_PREFIX = "/conversationBrain";
