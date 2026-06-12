/**
 * Shopify draft-order email domain checks and error detection.
 * Shopify rejects customer emails when the domain lacks resolvable MX and A records.
 */

import { promises as dns } from 'node:dns';
import { extractEmailDomain } from '../../calls/runtime/voice-email-enterprise-validation.util';

/** Shopify GraphQL / REST userError text for invalid recipient domains. */
export const SHOPIFY_INVALID_EMAIL_DOMAIN_PATTERNS = [
  /invalid domain name/i,
  /email contains an invalid domain/i,
  /email is invalid/i,
  /must be a valid email/i,
] as const;

export type ShopifyEmailDomainDnsCheck = {
  domain: string;
  mxResolvable: boolean;
  aResolvable: boolean;
  /** Shopify draft orders require both MX and A records on the domain. */
  shopifyLikelyAccepts: boolean;
};

export function isShopifyInvalidEmailDomainError(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  return SHOPIFY_INVALID_EMAIL_DOMAIN_PATTERNS.some((pattern) => pattern.test(text));
}

export async function checkShopifyEmailDomainDns(
  domain: string,
): Promise<ShopifyEmailDomainDnsCheck> {
  const normalized = domain.trim().toLowerCase();
  let mxResolvable = false;
  let aResolvable = false;

  try {
    const mx = await dns.resolveMx(normalized);
    mxResolvable = Array.isArray(mx) && mx.length > 0;
  } catch {
    mxResolvable = false;
  }

  try {
    const a = await dns.resolve4(normalized);
    aResolvable = Array.isArray(a) && a.length > 0;
  } catch {
    try {
      const aaaa = await dns.resolve6(normalized);
      aResolvable = Array.isArray(aaaa) && aaaa.length > 0;
    } catch {
      aResolvable = false;
    }
  }

  return {
    domain: normalized,
    mxResolvable,
    aResolvable,
    shopifyLikelyAccepts: mxResolvable && aResolvable,
  };
}

export function buildShopifyEmailRejectionLog(input: {
  originalEmail: string;
  normalizedEmail: string;
  domain: string | null;
  validationResult: string;
  shopifyUserErrors?: Array<{ field?: string[]; message?: string }>;
  mutation?: string;
}): Record<string, unknown> {
  return {
    event: 'shopify.email.domain_rejected',
    originalEmail: input.originalEmail,
    normalizedEmail: input.normalizedEmail,
    domain: input.domain ?? extractEmailDomain(input.normalizedEmail),
    validationResult: input.validationResult,
    validationSource: 'shopify_graphql',
    ...(input.mutation ? { mutation: input.mutation } : {}),
    ...(input.shopifyUserErrors?.length
      ? { shopifyUserErrors: input.shopifyUserErrors }
      : {}),
  };
}
