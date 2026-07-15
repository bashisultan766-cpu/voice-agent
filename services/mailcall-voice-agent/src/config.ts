import { z } from "zod";

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

let cached: MailCallConfig | null = null;

/**
 * Strip spaces from WordPress Application Passwords (UI often shows
 * "xxxx xxxx xxxx xxxx xxxx xxxx" — Basic Auth needs the contiguous form).
 */
export function cleanWpAppPassword(raw: string): string {
  return raw.replace(/\s+/g, "").trim();
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): MailCallConfig {
  if (cached) return cached;

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Mail Call config invalid: ${details}`);
  }

  const data = parsed.data;
  const wpBaseUrl = data.MAILCALL_WP_URL.replace(/\/$/, "");

  cached = {
    ...data,
    wpBaseUrl,
    wpAppPasswordClean: cleanWpAppPassword(data.MAILCALL_WP_APP_PASSWORD),
  };
  return cached;
}

/** Test-only: clear singleton so env can be re-parsed. */
export function resetConfigCache(): void {
  cached = null;
}

export const MAILCALL_API_PREFIX = "/api/voice/mailcall";
