import { ConfigService } from '@nestjs/config';
import { allowProviderEnvFallback } from './provider-env-fallback.util';

/** Provider API keys from environment — only when ALLOW_PROVIDER_ENV_FALLBACK=true. */
export type ProviderEnvSlice = {
  shopifyStoreUrl?: string;
  shopifyAdminToken?: string;
  openaiApiKey?: string;
  elevenlabsApiKey?: string;
  resendApiKey?: string;
  resendFromEmail?: string;
};

function trimEnv(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t || undefined;
}

export function gatedProcessEnv(key: string, config?: ConfigService): string | undefined {
  if (!allowProviderEnvFallback()) return undefined;
  const raw = config?.get<string>(key) ?? process.env[key];
  return trimEnv(raw);
}

/** Env slice for credential resolvers; undefined when provider env fallback is disabled. */
export function buildProviderEnvSlice(config?: ConfigService): ProviderEnvSlice | undefined {
  if (!allowProviderEnvFallback()) return undefined;
  return {
    shopifyStoreUrl: gatedProcessEnv('SHOPIFY_SHOP_DOMAIN', config),
    shopifyAdminToken: gatedProcessEnv('SHOPIFY_ADMIN_API_TOKEN', config),
    openaiApiKey: gatedProcessEnv('OPENAI_API_KEY', config),
    elevenlabsApiKey: gatedProcessEnv('ELEVENLABS_API_KEY', config),
    resendApiKey: gatedProcessEnv('RESEND_API_KEY', config),
    resendFromEmail: gatedProcessEnv('RESEND_FROM_EMAIL', config),
  };
}
