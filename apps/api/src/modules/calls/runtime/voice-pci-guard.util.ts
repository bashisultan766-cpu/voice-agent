/**
 * Voice commerce PCI guard — allow hosted Shopify checkout (email + URL only).
 * Block raw card/CVV/bank data; do not treat Shopify catalog IDs as card numbers.
 */

export const SAFE_HOSTED_CHECKOUT_TOOLS = new Set([
  'createCheckoutLink',
  'sendPaymentEmail',
  'create_draft_order',
  'create_checkout_or_invoice_payment_link',
  'searchProducts',
  'getProductDetails',
  'getProductAvailability',
  'ShopifyProductSearch',
  'ShopifyProductDetails',
  'CreatePaymentLink',
  'GetOrderStatus',
]);

/** Keys that may contain long numeric Shopify IDs — never run PAN heuristics on these. */
const COMMERCE_ID_KEYS = new Set([
  'productId',
  'product_id',
  'variantId',
  'variant_id',
  'id',
  'checkoutLinkId',
  'checkout_link_id',
  'primaryVariantId',
  'selectedVariantId',
  'orderNumber',
  'order_number',
  'sku',
  'handle',
  'storeId',
  'tenantId',
  'callSessionId',
  'requestId',
]);

const FORBIDDEN_PAYMENT_KEYS = new Set([
  'card',
  'cardNumber',
  'card_number',
  'cvv',
  'cvc',
  'expiry',
  'exp',
  'expiration',
  'securityCode',
  'security_code',
  'iban',
  'bankAccount',
  'bank_account',
  'routingNumber',
  'routing_number',
]);

const LABELED_CARD_PATTERN =
  /\b(?:cvv|cvc|security\s*code|card\s*number|card\s*#|expir(?:y|ation)|valid\s*thru)\b/i;

export function isSafeHostedCheckoutOnlyEnabled(): boolean {
  return process.env.SAFE_HOSTED_CHECKOUT_ONLY !== 'false';
}

export function isHostedCheckoutCommerceTool(toolName: string): boolean {
  return SAFE_HOSTED_CHECKOUT_TOOLS.has(toolName);
}

function isShopifyGid(value: string): boolean {
  return /^gid:\/\/shopify\//i.test(value.trim());
}

function isLikelyCatalogNumericId(key: string, value: string): boolean {
  if (!COMMERCE_ID_KEYS.has(key)) return false;
  const t = value.trim();
  if (isShopifyGid(t)) return true;
  if (/^\d{8,20}$/.test(t)) return true;
  return false;
}

function passesLuhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function stringContainsRawCardData(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (isShopifyGid(text)) return false;
  if (LABELED_CARD_PATTERN.test(text)) return true;

  const digitRuns = text.match(/\b(?:\d[ \-]*?){13,19}\b/g) ?? [];
  for (const run of digitRuns) {
    const digits = run.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) {
      return true;
    }
  }
  return false;
}

export type VoicePciAssessment = {
  blocked: boolean;
  permissionDecision: 'allow_hosted_checkout' | 'block_raw_card_data' | 'allow_commerce_identifier';
  pciRestrictionReason?: string;
};

function assessValue(key: string, value: unknown, depth = 0): VoicePciAssessment | null {
  if (depth > 4) return null;

  if (FORBIDDEN_PAYMENT_KEYS.has(key)) {
    return {
      blocked: true,
      permissionDecision: 'block_raw_card_data',
      pciRestrictionReason: `forbidden_key:${key}`,
    };
  }

  if (typeof value === 'string') {
    if (isLikelyCatalogNumericId(key, value)) {
      return {
        blocked: false,
        permissionDecision: 'allow_commerce_identifier',
      };
    }
    if (key === 'email' || key === 'query' || key === 'title' || key === 'reason') {
      if (stringContainsRawCardData(value)) {
        return {
          blocked: true,
          permissionDecision: 'block_raw_card_data',
          pciRestrictionReason: 'labeled_or_luhn_card_in_text_field',
        };
      }
      return { blocked: false, permissionDecision: 'allow_hosted_checkout' };
    }
    if (stringContainsRawCardData(value)) {
      return {
        blocked: true,
        permissionDecision: 'block_raw_card_data',
        pciRestrictionReason: 'luhn_valid_card_number_pattern',
      };
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = assessValue(key, item, depth + 1);
      if (hit?.blocked) return hit;
    }
    return null;
  }

  if (value && typeof value === 'object') {
    for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      const hit = assessValue(nestedKey, nestedValue, depth + 1);
      if (hit?.blocked) return hit;
    }
  }

  return null;
}

/**
 * Returns whether tool args contain raw card data (not Shopify variant/product IDs).
 */
export function assessVoiceToolPciRisk(
  toolName: string,
  args: Record<string, unknown>,
): VoicePciAssessment {
  if (isSafeHostedCheckoutOnlyEnabled() && isHostedCheckoutCommerceTool(toolName)) {
    for (const [key, value] of Object.entries(args)) {
      if (key === 'tenantId' || key === 'storeId') continue;
      const hit = assessValue(key, value);
      if (hit?.blocked) return hit;
    }
    return {
      blocked: false,
      permissionDecision: 'allow_hosted_checkout',
    };
  }

  for (const [key, value] of Object.entries(args)) {
    const hit = assessValue(key, value);
    if (hit?.blocked) return hit;
  }

  return {
    blocked: false,
    permissionDecision: 'allow_hosted_checkout',
  };
}

/** Caller speech only — blocks obvious card dictation. */
export function callerSpeechContainsRawCardData(text: string): boolean {
  return stringContainsRawCardData(text);
}
