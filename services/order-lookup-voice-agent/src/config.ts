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
  VOICE_MODEL: z.string().default("eleven_turbo_v2_5"),
  VOICE_LANGUAGE: z.string().default("en-US"),
  VOICE_TTS_PROVIDER: z.string().default("ElevenLabs"),

  ORDER_LOOKUP_MAX_RETRIES: z.coerce.number().default(2),
  VOICE_ROUTER_FORWARD_SECRET: z.string().optional(),
  VOICE_CHUNK_MAX_PAUSE_MS: z.coerce.number().default(120),
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid environment configuration: ${missing}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export function conversationRelayVoice(): string {
  const cfg = getConfig();
  const voiceId = (cfg.VOICE_ID || cfg.ELEVENLABS_VOICE_ID || "").trim();
  if (cfg.VOICE_TTS_PROVIDER.toLowerCase() === "elevenlabs" && voiceId) {
    return `${voiceId}-${cfg.VOICE_MODEL}`;
  }
  return "Google.en-US-Neural2-J";
}

export function wsUrl(): string {
  const base = getConfig().PUBLIC_BASE_URL.replace(/^http/, "ws").replace(/\/$/, "");
  return `${base}/voice/twilio/ws`;
}

/** Standard Twilio ConversationRelay paths (same webhook URL as before). */
export const VOICE_PATH_PREFIX = "/voice/twilio";
