import { z } from "zod";
import { envLoadReport, REPO_ROOT, SERVICE_ROOT } from "./bootstrapEnv.js";

export const DEFAULT_MAILCALL_PORT = 8010;

/** Production WordPress origin (GoDaddy) — no trailing slash. */
export const DEFAULT_MAILCALL_WP_URL = "https://mailcallnewspaper.com";

/** Production voice public origin (VPS / Twilio) — no trailing slash. */
export const DEFAULT_MAILCALL_PUBLIC_BASE_URL = "https://agent.mailcallcommunication.com";

/** EX_CONFIG — reserved for truly fatal boots (listen bind failure). Soft config uses degraded mode. */
export const CONFIG_EXIT_CODE = 78;

const envSchema = z.object({
  MAILCALL_PUBLIC_BASE_URL: z.string().url().optional(),
  MAILCALL_TWILIO_PHONE_NUMBER: z.string().min(1),
  MAILCALL_TWILIO_AUTH_TOKEN: z.string().optional().default(""),
  MAILCALL_VALIDATE_TWILIO_SIGNATURES: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false" && v !== "0"),
  /**
   * When false (default), a bad Twilio signature is logged but the call still
   * receives ConversationRelay TwiML. Set true only after auth token + URL are proven.
   */
  MAILCALL_TWILIO_SIGNATURE_STRICT: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v.toLowerCase() === "true" || v === "1"),
  MAILCALL_WP_URL: z.string().url(),
  MAILCALL_WP_USER: z.string().min(1),
  MAILCALL_WP_APP_PASSWORD: z.string().min(1),
  MAILCALL_OPENAI_API_KEY: z.string().optional().default(""),
  MAILCALL_OPENAI_MODEL: z.string().optional().default("gpt-4o-mini"),
  /** E.164 live-agent number for transfer_to_number (optional). */
  MAILCALL_TRANSFER_NUMBER: z.string().optional().default(""),
  MAILCALL_CACHE_TTL_MS: z.coerce.number().int().positive().optional().default(60_000),
  MAILCALL_WP_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(2_000),
  MAILCALL_PORT: z.coerce.number().int().positive().optional(),
  MAILCALL_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
  /** Send Newspaper / register checkout page emailed to callers. */
  MAILCALL_CHECKOUT_URL: z.string().url().optional(),
  /** Shared Resend credentials (repo-root or service .env). Optional — checkout/escalation falls back to voicemail guidance. */
  RESEND_API_KEY: z.string().optional().default(""),
  RESEND_FROM_EMAIL: z.string().optional().default(""),
  RESEND_FROM_NAME: z.string().optional().default("MailCall Newspaper"),
});

export type MailCallConfig = Omit<z.infer<typeof envSchema>, "MAILCALL_PORT" | "MAILCALL_PUBLIC_BASE_URL"> & {
  MAILCALL_PORT: number;
  MAILCALL_PUBLIC_BASE_URL?: string;
  /** WordPress Application Password with spaces stripped for Basic Auth. */
  wpAppPasswordClean: string;
  wpBaseUrl: string;
};

export type MailCallRuntimeState = {
  config: MailCallConfig;
  /** True when WP/Twilio config is incomplete or invalid after self-heal. */
  degraded: boolean;
  degradeReasons: string[];
};

let runtimeState: MailCallRuntimeState | null = null;

/**
 * Strip spaces from WordPress Application Passwords (UI often shows
 * "xxxx xxxx xxxx xxxx xxxx xxxx" — Basic Auth needs the contiguous form).
 */
export function cleanWpAppPassword(raw: string): string {
  return raw.replace(/\s+/g, "").trim();
}

/**
 * Self-heal URL-like env values from VPS copy/paste:
 * 1) trim + strip CR/LF/TAB/BOM
 * 2) if scheme missing, prepend https://
 * Pure function — does not mutate process.env.
 */
export function sanitizeHttpUrl(raw: unknown): string {
  let s = String(raw ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/[\r\n\t]+/g, "");

  if (!s) return "";

  // Bare host (mailcall.example) → https://mailcall.example
  if (!/^https?:\/\//i.test(s)) {
    s = `https://${s}`;
  }

  // Config URLs are origins — strip trailing slashes so clients never double-slash paths.
  s = s.replace(/\/+$/, "");

  return s;
}

/** Optional URL: empty after sanitize → undefined; invalid → undefined. */
export function sanitizeOptionalHttpUrl(raw: unknown): string | undefined {
  const s = sanitizeHttpUrl(raw);
  if (!s) return undefined;
  try {
    new URL(s);
    return s;
  } catch {
    return undefined;
  }
}

/**
 * Resolve listen port with hard fallback to 8010.
 * Accepts MAILCALL_PORT or PORT; rejects NaN / 0 / out-of-range.
 */
export function resolveListenPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MAILCALL_PORT ?? env.PORT ?? String(DEFAULT_MAILCALL_PORT);
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    return DEFAULT_MAILCALL_PORT;
  }
  return n;
}

/** Build a sanitized env snapshot for Zod (no side effects on process.env). */
export function sanitizeEnvForValidation(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const wpUrl = sanitizeHttpUrl(env.MAILCALL_WP_URL);
  const publicUrl = sanitizeOptionalHttpUrl(env.MAILCALL_PUBLIC_BASE_URL);

  return {
    ...env,
    MAILCALL_WP_URL: wpUrl || undefined,
    MAILCALL_PUBLIC_BASE_URL: publicUrl,
    MAILCALL_TWILIO_PHONE_NUMBER: String(env.MAILCALL_TWILIO_PHONE_NUMBER ?? "").trim() || undefined,
    // Twilio auth tokens must not contain whitespace from .env paste artifacts.
    MAILCALL_TWILIO_AUTH_TOKEN: String(env.MAILCALL_TWILIO_AUTH_TOKEN ?? "")
      .replace(/\s+/g, "")
      .trim(),
    MAILCALL_WP_USER: String(env.MAILCALL_WP_USER ?? "").trim() || undefined,
    MAILCALL_WP_APP_PASSWORD: String(env.MAILCALL_WP_APP_PASSWORD ?? "").trim() || undefined,
    MAILCALL_OPENAI_API_KEY: String(env.MAILCALL_OPENAI_API_KEY ?? "").trim(),
    MAILCALL_OPENAI_MODEL: String(env.MAILCALL_OPENAI_MODEL ?? "").trim() || undefined,
    MAILCALL_TRANSFER_NUMBER: String(env.MAILCALL_TRANSFER_NUMBER ?? "")
      .replace(/\s+/g, "")
      .trim(),
    MAILCALL_PORT: String(env.MAILCALL_PORT ?? env.PORT ?? DEFAULT_MAILCALL_PORT).trim(),
    MAILCALL_LOG_LEVEL: String(env.MAILCALL_LOG_LEVEL ?? "info").trim() || "info",
    MAILCALL_CHECKOUT_URL: sanitizeOptionalHttpUrl(env.MAILCALL_CHECKOUT_URL),
    RESEND_API_KEY: String(env.RESEND_API_KEY ?? "").trim(),
    RESEND_FROM_EMAIL: String(env.RESEND_FROM_EMAIL ?? "").trim(),
    RESEND_FROM_NAME: String(env.RESEND_FROM_NAME ?? "MailCall Newspaper").trim() || "MailCall Newspaper",
  };
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function buildDegradedConfig(
  env: NodeJS.ProcessEnv,
  sanitized: Record<string, string | undefined>,
  reasons: string[],
): MailCallConfig {
  const wpRaw = sanitized.MAILCALL_WP_URL ?? "";
  // Keep a syntactically valid placeholder so clients never build relative URLs.
  const wpBaseUrl = isValidHttpUrl(wpRaw) ? wpRaw.replace(/\/$/, "") : "https://invalid.local";

  return {
    MAILCALL_PUBLIC_BASE_URL: sanitized.MAILCALL_PUBLIC_BASE_URL,
    MAILCALL_TWILIO_PHONE_NUMBER: sanitized.MAILCALL_TWILIO_PHONE_NUMBER ?? "",
    MAILCALL_TWILIO_AUTH_TOKEN: sanitized.MAILCALL_TWILIO_AUTH_TOKEN ?? "",
    MAILCALL_VALIDATE_TWILIO_SIGNATURES:
      String(env.MAILCALL_VALIDATE_TWILIO_SIGNATURES ?? "true").toLowerCase() !== "false" &&
      String(env.MAILCALL_VALIDATE_TWILIO_SIGNATURES ?? "true") !== "0",
    MAILCALL_TWILIO_SIGNATURE_STRICT:
      String(env.MAILCALL_TWILIO_SIGNATURE_STRICT ?? "false").toLowerCase() === "true" ||
      String(env.MAILCALL_TWILIO_SIGNATURE_STRICT ?? "false") === "1",
    MAILCALL_WP_URL: wpBaseUrl,
    MAILCALL_WP_USER: sanitized.MAILCALL_WP_USER ?? "",
    MAILCALL_WP_APP_PASSWORD: sanitized.MAILCALL_WP_APP_PASSWORD ?? "",
    MAILCALL_OPENAI_API_KEY: sanitized.MAILCALL_OPENAI_API_KEY ?? "",
    MAILCALL_OPENAI_MODEL: sanitized.MAILCALL_OPENAI_MODEL ?? "gpt-4o-mini",
    MAILCALL_TRANSFER_NUMBER: sanitized.MAILCALL_TRANSFER_NUMBER ?? "",
    MAILCALL_CACHE_TTL_MS: Number(env.MAILCALL_CACHE_TTL_MS) > 0 ? Number(env.MAILCALL_CACHE_TTL_MS) : 60_000,
    MAILCALL_WP_TIMEOUT_MS: Number(env.MAILCALL_WP_TIMEOUT_MS) > 0 ? Number(env.MAILCALL_WP_TIMEOUT_MS) : 2_000,
    MAILCALL_PORT: resolveListenPort(env),
    MAILCALL_LOG_LEVEL: (["debug", "info", "warn", "error"] as const).includes(
      sanitized.MAILCALL_LOG_LEVEL as "info",
    )
      ? (sanitized.MAILCALL_LOG_LEVEL as MailCallConfig["MAILCALL_LOG_LEVEL"])
      : "info",
    MAILCALL_CHECKOUT_URL: sanitized.MAILCALL_CHECKOUT_URL,
    RESEND_API_KEY: sanitized.RESEND_API_KEY ?? "",
    RESEND_FROM_EMAIL: sanitized.RESEND_FROM_EMAIL ?? "",
    RESEND_FROM_NAME: sanitized.RESEND_FROM_NAME || "MailCall Newspaper",
    wpBaseUrl,
    wpAppPasswordClean: cleanWpAppPassword(sanitized.MAILCALL_WP_APP_PASSWORD ?? ""),
  };
}

export function formatConfigDegradedWarning(reasons: string[]): string {
  return [
    "WARN: Mail Call starting in DEGRADED mode — Express will still bind so health probes stay reachable.",
    ...reasons.map((r) => `  • ${r}`),
    `Env files loaded: ${envLoadReport.loaded.length ? envLoadReport.loaded.join(", ") : "(none)"}`,
    `Tried: ${envLoadReport.candidates.join(", ")}`,
    "Fix:",
    `  1) ${REPO_ROOT}/.env`,
    `  2) ${SERVICE_ROOT}/.env`,
    `  Template: ${SERVICE_ROOT}/.env.example`,
    "Then: pm2 restart mailcall-voice-agent --update-env",
    "Readiness: GET /api/voice/mailcall/health → 503 while degraded.",
  ].join("\n");
}

/**
 * Validate + self-heal env. Never throws for soft config issues.
 * Always returns a runtime state the HTTP server can boot with.
 */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): MailCallRuntimeState {
  const sanitized = sanitizeEnvForValidation(env);
  const reasons: string[] = [];

  const rawWp = String(env.MAILCALL_WP_URL ?? "");
  const healedWp = sanitized.MAILCALL_WP_URL ?? "";
  if (rawWp.trim() && healedWp && !/^https?:\/\//i.test(rawWp.trim())) {
    // Informational — self-heal applied (not a degrade reason by itself).
  }
  if (!healedWp || !isValidHttpUrl(healedWp)) {
    reasons.push(
      `MAILCALL_WP_URL invalid after sanitize (raw=${JSON.stringify(rawWp)} healed=${JSON.stringify(healedWp)})`,
    );
  }
  if (!sanitized.MAILCALL_TWILIO_PHONE_NUMBER) {
    reasons.push("MAILCALL_TWILIO_PHONE_NUMBER missing");
  }
  if (!sanitized.MAILCALL_WP_USER) {
    reasons.push("MAILCALL_WP_USER missing");
  }
  if (!sanitized.MAILCALL_WP_APP_PASSWORD) {
    reasons.push("MAILCALL_WP_APP_PASSWORD missing");
  }

  const parsed = envSchema.safeParse(sanitized);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      reasons.push(`${issue.path.join(".")}: ${issue.message}`);
    }
    const unique = [...new Set(reasons)];
    return {
      degraded: true,
      degradeReasons: unique,
      config: buildDegradedConfig(env, sanitized, unique),
    };
  }

  const data = parsed.data;
  const wpBaseUrl = data.MAILCALL_WP_URL.replace(/\/$/, "");
  const config: MailCallConfig = {
    ...data,
    MAILCALL_PUBLIC_BASE_URL: sanitized.MAILCALL_PUBLIC_BASE_URL ?? data.MAILCALL_PUBLIC_BASE_URL,
    MAILCALL_PORT: resolveListenPort(env),
    wpBaseUrl,
    wpAppPasswordClean: cleanWpAppPassword(data.MAILCALL_WP_APP_PASSWORD),
  };

  if (reasons.length > 0) {
    const unique = [...new Set(reasons)];
    return { degraded: true, degradeReasons: unique, config };
  }

  return { degraded: false, degradeReasons: [], config };
}

/** Initialize/replace singleton runtime state (called once at boot). */
export function initRuntimeConfig(env: NodeJS.ProcessEnv = process.env): MailCallRuntimeState {
  runtimeState = loadRuntimeConfig(env);
  return runtimeState;
}

export function getRuntimeState(): MailCallRuntimeState {
  if (!runtimeState) {
    runtimeState = loadRuntimeConfig();
  }
  return runtimeState;
}

export function isConfigDegraded(): boolean {
  return getRuntimeState().degraded;
}

export function getDegradeReasons(): string[] {
  return getRuntimeState().degradeReasons;
}

export function getConfig(env?: NodeJS.ProcessEnv): MailCallConfig {
  if (env) {
    return loadRuntimeConfig(env).config;
  }
  return getRuntimeState().config;
}

/** @deprecated Prefer loadRuntimeConfig — kept for older call sites. */
export type ConfigValidation =
  | { ok: true; config: MailCallConfig }
  | { ok: false; message: string; degraded?: boolean };

export function validateConfig(env: NodeJS.ProcessEnv = process.env): ConfigValidation {
  const state = loadRuntimeConfig(env);
  if (state.degraded) {
    return {
      ok: false,
      degraded: true,
      message: formatConfigDegradedWarning(state.degradeReasons),
    };
  }
  return { ok: true, config: state.config };
}

/** Test-only: clear singleton so env can be re-parsed. */
export function resetConfigCache(): void {
  runtimeState = null;
}

export const MAILCALL_API_PREFIX = "/api/voice/mailcall";
