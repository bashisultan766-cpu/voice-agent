import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  PORT: z.coerce.number().default(8000),
  PUBLIC_BASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  TWILIO_AUTH_TOKEN: z.string().min(1),
  VALIDATE_TWILIO_SIGNATURES: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  VOICE_ROUTER_FORWARD_SECRET: z.string().min(8),

  ORDER_LOOKUP_INBOUND_URL: z.string().url().default("http://127.0.0.1:8002/voice/order/twilio/inbound"),
  MAIN_AGENT_INBOUND_URL: z.string().url().default("http://127.0.0.1:8001/voice/twilio/agent/inbound"),
  ORDER_LOOKUP_HEALTH_URL: z.string().url().default("http://127.0.0.1:8002/health"),
  AGENT_FORWARD_TIMEOUT_MS: z.coerce.number().default(8000),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().default(2000),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_TIMEOUT_MS: z.coerce.number().default(5000),

  SESSION_TTL_SECS: z.coerce.number().default(3600),
  GATHER_TIMEOUT_SECS: z.coerce.number().default(5),
});

export type AppConfig = z.infer<typeof envSchema>;
export type AgentTarget = "order_lookup" | "main_agent";

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

export function routerBaseUrl(): string {
  return getConfig().PUBLIC_BASE_URL.replace(/\/$/, "");
}
