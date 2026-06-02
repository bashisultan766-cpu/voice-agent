/** Placeholder variant IDs sometimes sent by voice tools before catalog lookup. */
const VARIANT_ID_PLACEHOLDER = /^(YOUR_|PLACEHOLDER|TBD|UNKNOWN|REPLACE|VARIANT_ID|N\/A|-)$/i;

/**
 * True when the value is a real Shopify variant id (not empty / placeholder).
 */
export function isUsableShopifyVariantId(variantId: string | undefined | null): variantId is string {
  const v = variantId?.trim();
  if (!v || v.length > 128) return false;
  if (VARIANT_ID_PLACEHOLDER.test(v)) return false;
  if (/^gid:\/\/shopify\/ProductVariant\/.+/i.test(v)) return true;
  if (/^\d+$/.test(v)) return true;
  return false;
}

export type ResolvePaymentVariantSource = 'provided' | 'search';

export type ResolvePaymentVariantSuccess = {
  ok: true;
  variantId: string;
  source: ResolvePaymentVariantSource;
  productTitle?: string;
};

export type ResolvePaymentVariantFailure = {
  ok: false;
  errorCode: 'missing_product_query' | 'search_failed' | 'no_matches' | 'invalid_search_result';
  agentMessage: string;
  logMessage: string;
};

export type ResolvePaymentVariantResult =
  | ResolvePaymentVariantSuccess
  | ResolvePaymentVariantFailure;

export function buildMissingProductQueryFailure(): ResolvePaymentVariantFailure {
  return {
    ok: false,
    errorCode: 'missing_product_query',
    agentMessage:
      "I couldn't identify which book to charge for. Could you tell me the title again?",
    logMessage: 'variantId missing and no productName for automatic search',
  };
}

export function buildNoSearchMatchesFailure(query: string): ResolvePaymentVariantFailure {
  return {
    ok: false,
    errorCode: 'no_matches',
    agentMessage:
      "I couldn't find that book in our catalog right now. Would you like to try another title?",
    logMessage: `search-product returned no matches for query="${query.slice(0, 80)}"`,
  };
}

export function buildSearchFailedFailure(error: string): ResolvePaymentVariantFailure {
  return {
    ok: false,
    errorCode: 'search_failed',
    agentMessage:
      "I'm having trouble looking up that book. Let me try again — what's the title?",
    logMessage: `search-product failed: ${error.slice(0, 200)}`,
  };
}
