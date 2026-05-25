/**
 * Provider API keys from process.env must not power production agents unless explicitly allowed.
 * Infrastructure keys (DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY) are unrelated.
 */
export function allowProviderEnvFallback(): boolean {
  if (process.env.NODE_ENV !== 'production') {
    return true;
  }
  return (
    process.env.ALLOW_PROVIDER_ENV_FALLBACK === 'true' ||
    process.env.SINGLE_TENANT_MODE === 'true'
  );
}
