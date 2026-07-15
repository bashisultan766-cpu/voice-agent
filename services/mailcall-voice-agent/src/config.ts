import { z } from "zod";
import { envLoadReport, REPO_ROOT, SERVICE_ROOT } from "./bootstrapEnv.js";

const REQUIRED_KEYS = [
  "MAILCALL_TWILIO_PHONE_NUMBER",
  "MAILCALL_WP_URL",
  "MAILCALL_WP_USER",
  "MAILCALL_WP_APP_PASSWORD",
] as const;

const envSchema = z.object({
  MAILCALL_PUBLIC_BASE_URL: z.string().url().optional(),
  MAILCALL_TWILIO_PHONE_NUMBER: z.string().min(1),
  MAILCALL_TWILIO_AUTH_TOKEN: z.string().optional().default(""),
  MAILCALL_VALIDATE_TWILIO_SIGNATURES: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false" && v !== "0"),
  MAILCALL_WP_URL: z.string().url(),
  MAILCALL_WP_USER: z.string().min(1),
  MAILCALL_WP_APP_PASSWORD: z.string().min(1),
  MAILCALL_OPENAI_API_KEY: z.string().optional().default(""),
  MAILCALL_OPENAI_MODEL: z.string().optional().default("gpt-4o-mini"),
  MAILCALL_CACHE_TTL_MS: z.coerce.number().int().positive().optional().default(60_000),
  MAILCALL_WP_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(2_500),
  MAILCALL_PORT: z.coerce.number().int().positive().optional().default(8010),
  MAILCALL_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
});

export type MailCallConfig = z.infer<typeof envSchema> & {
  /** WordPress Application Password with spaces stripped for Basic Auth. */
  wpAppPasswordClean: string;
  wpBaseUrl: string;
};

/** EX_CONFIG — PM2 stop_exit_codes should include this to avoid restart storms. */
export const CONFIG_EXIT_CODE = 78;

let cached: MailCallConfig | null = null;

/**
 * Strip spaces from WordPress Application Passwords (UI often shows
 * "xxxx xxxx xxxx xxxx xxxx xxxx" — Basic Auth needs the contiguous form).
 */
export function cleanWpAppPassword(raw: string): string {
  return raw.replace(/\s+/g, "").trim();
}

export function listMissingRequiredKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return REQUIRED_KEYS.filter((key) => !String(env[key] ?? "").trim());
}

/** Human-readable boot failure for operators (stdout + PM2 error log). */
export function formatConfigBootError(details: string): string {
  const missing = listMissingRequiredKeys();
  const lines = [
    "Mail Call voice agent refused to start: configuration invalid.",
    details,
    "",
    `Env files loaded: ${envLoadReport.loaded.length ? envLoadReport.loaded.join(", ") : "(none)"}`,
    `Tried: ${envLoadReport.candidates.join(", ")}`,
    "",
    "Required variables:",
    ...REQUIRED_KEYS.map((k) => `  - ${k}${missing.includes(k) ? "  ← MISSING" : ""}`),
    "",
    "Fix on the VPS (either file works):",
    `  1) ${REPO_ROOT}/.env`,
    `  2) ${SERVICE_ROOT}/.env`,
    `  Template: ${SERVICE_ROOT}/.env.example`,
    "Then: pm2 restart mailcall-voice-agent --update-env",
  ];
  return lines.join("\n");
}

export type ConfigValidation =
  | { ok: true; config: MailCallConfig }
  | { ok: false; message: string };

export function validateConfig(env: NodeJS.ProcessEnv = process.env): ConfigValidation {
  const missing = listMissingRequiredKeys(env);
  if (missing.length > 0) {
    return {
      ok: false,
      message: formatConfigBootError(`Missing required env: ${missing.join(", ")}`),
    };
  }

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      message: formatConfigBootError(details),
    };
  }

  const data = parsed.data;
  const wpBaseUrl = data.MAILCALL_WP_URL.replace(/\/$/, "");
  return {
    ok: true,
    config: {
      ...data,
      wpBaseUrl,
      wpAppPasswordClean: cleanWpAppPassword(data.MAILCALL_WP_APP_PASSWORD),
    },
  };
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): MailCallConfig {
  if (cached) return cached;

  const result = validateConfig(env);
  if (!result.ok) {
    throw new Error(result.message);
  }

  cached = result.config;
  return cached;
}

/** Test-only: clear singleton so env can be re-parsed. */
export function resetConfigCache(): void {
  cached = null;
}

export const MAILCALL_API_PREFIX = "/api/voice/mailcall";
