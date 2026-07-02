import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

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
  SHOPIFY_ADMIN_ACCESS_TOKEN: z.string().min(1),
  SHOPIFY_API_VERSION: z.string().default("2024-01"),
  SHOPIFY_TIMEOUT_MS: z.coerce.number().default(10000),
  SHOPIFY_CACHE_TTL_SECS: z.coerce.number().default(60),

  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  VOICE_ID: z.string().optional(),
  /** Twilio ConversationRelay model slug (e.g. flash_v2_5). ElevenLabs API prefixes (eleven_*) are stripped automatically. */
  VOICE_MODEL: z.string().default("flash_v2_5"),
  /** Twilio ConversationRelay tuning — speed 0.7–1.2, stability/similarity 0.0–1.0 */
  VOICE_SPEED: z.coerce.number().min(0.7).max(1.2).default(0.96),
  VOICE_STABILITY: z.coerce.number().min(0).max(1).default(0.42),
  VOICE_SIMILARITY: z.coerce.number().min(0).max(1).default(0.78),
  VOICE_TUNING_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  VOICE_LANGUAGE: z.string().default("en-US"),
  VOICE_TTS_PROVIDER: z.string().default("ElevenLabs"),

  ORDER_LOOKUP_MAX_RETRIES: z.coerce.number().default(2),
  VOICE_ROUTER_FORWARD_SECRET: z.string().optional(),
  VOICE_CHUNK_MAX_PAUSE_MS: z.coerce.number().default(120),

  SAFE_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
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

export function getConfig(): AppConfig {
  if (!cached) {
    const parsed = envSchema.safeParse(trimStrings(process.env as Record<string, unknown>));
    if (!parsed.success) {
      const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid environment configuration: ${missing}`);
    }
    cached = parsed.data;
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
  return `${base}/voice/twilio/ws`;
}

/** Standard Twilio ConversationRelay paths (same webhook URL as before). */
export const VOICE_PATH_PREFIX = "/voice/twilio";
