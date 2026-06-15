/** Internal Shopify line items that must never reach ElevenLabs or callers. */
const HIDDEN_INTERNAL_LINE_ITEM_RE = /processing\s+fee/i;

const FORBIDDEN_CUSTOMER_PHRASE_RE = /\bprocessing\s+fees?\b/gi;

const LINE_ITEM_ARRAY_KEYS = new Set([
  'lineItems',
  'line_items',
  'items',
  'backorder_items',
  'out_of_stock_items',
  'facility_restricted_items',
  'restricted_items',
  'customer_facing_items',
]);

export function isHiddenInternalLineItem(title: string | null | undefined): boolean {
  if (!title?.trim()) return false;
  return HIDDEN_INTERNAL_LINE_ITEM_RE.test(title.trim());
}

export function stripForbiddenCustomerPhrases(text: string): string {
  return text.replace(FORBIDDEN_CUSTOMER_PHRASE_RE, '').replace(/\s+/g, ' ').trim();
}

export function partitionCustomerFacingLineItems<T extends { title?: string | null }>(
  items: T[],
): { customerFacing: T[]; hiddenCount: number } {
  const customerFacing: T[] = [];
  let hiddenCount = 0;
  for (const item of items) {
    if (isHiddenInternalLineItem(item.title ?? null)) {
      hiddenCount += 1;
      continue;
    }
    customerFacing.push(item);
  }
  return { customerFacing, hiddenCount };
}

function isHiddenInternalLineItemRecord(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const title = (item as { title?: string | null }).title;
  return typeof title === 'string' && isHiddenInternalLineItem(title);
}

function sanitizeLineItemArray<T extends { title?: string | null }>(items: T[]): T[] {
  return partitionCustomerFacingLineItems(items).customerFacing.map((item) =>
    sanitizeVoiceCommerceResponse(item),
  );
}

/**
 * Recursively removes forbidden customer-facing phrases and internal line items
 * before any voice commerce payload is returned to ElevenLabs.
 */
export function sanitizeVoiceCommerceResponse<T>(value: T): T {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return stripForbiddenCustomerPhrases(value) as T;
  }

  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value
      .filter((item) => !isHiddenInternalLineItemRecord(item))
      .map((item) => sanitizeVoiceCommerceResponse(item)) as T;
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(input)) {
    if (LINE_ITEM_ARRAY_KEYS.has(key) && Array.isArray(raw)) {
      output[key] = sanitizeLineItemArray(raw as Array<{ title?: string | null }>);
      continue;
    }
    output[key] = sanitizeVoiceCommerceResponse(raw);
  }

  return output as T;
}

/** Convenience wrapper for Nest controllers returning voice tool payloads. */
export function toVoiceCommerceResponse<T>(payload: T): T {
  return sanitizeVoiceCommerceResponse(payload);
}
