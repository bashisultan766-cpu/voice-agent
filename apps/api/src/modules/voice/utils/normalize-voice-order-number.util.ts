/** Strip spoken/formatting noise from an order number (e.g. "# 10 10" → "1010"). */
export function normalizeVoiceOrderNumber(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const withoutHash = trimmed.replace(/^#+\s*/, '');
  const digitsOnly = withoutHash.replace(/\D/g, '');
  if (digitsOnly.length >= 3) return digitsOnly;

  return withoutHash.replace(/\s+/g, '').toUpperCase();
}

/** Shopify order `name` search tokens (e.g. 1010 → #1010). */
export function shopifyOrderNameSearchTokens(orderNumber: string): string[] {
  const normalized = normalizeVoiceOrderNumber(orderNumber);
  if (!normalized) return [];

  const tokens = new Set<string>();
  tokens.add(normalized);
  if (!normalized.startsWith('#')) {
    tokens.add(`#${normalized}`);
  }
  return [...tokens];
}
