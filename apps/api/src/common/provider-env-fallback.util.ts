/**
 * Provider API keys from process.env must not power agents unless explicitly allowed.
 * Set ALLOW_PROVIDER_ENV_FALLBACK=true only for local/dev bootstrap — never in production multi-tenant.
 * Infrastructure keys (DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY) are unrelated.
 */
export function allowProviderEnvFallback(): boolean {
  return process.env.ALLOW_PROVIDER_ENV_FALLBACK === 'true';
}
