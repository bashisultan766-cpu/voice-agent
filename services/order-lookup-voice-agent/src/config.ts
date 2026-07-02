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

  ELEVENLABS_API_KEY: z.string().min(1),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  VOICE_ID: z.string().optional(),
  ELEVENLABS_MODEL: z.string().default("eleven_turbo_v2_5"),
  VOICE_STABILITY: z.coerce.number().min(0).max(1).default(0.42),
  VOICE_SIMILARITY: z.coerce.number().min(0).max(1).default(0.78),
  VOICE_LANGUAGE: z.string().default("en-US"),

  AUDIO_CACHE_DIR: z.string().default("./audio-cache"),
  AUDIO_CACHE_TTL_MS: z.coerce.number().default(60 * 60 * 1000),

  ORDER_LOOKUP_MAX_RETRIES: z.coerce.number().default(2),
  VOICE_ROUTER_FORWARD_SECRET: z.string().optional(),

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

/** Standard Twilio voice webhook paths. */
export const VOICE_PATH_PREFIX = "/voice/twilio";
