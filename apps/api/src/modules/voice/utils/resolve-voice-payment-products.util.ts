import { pickString } from './normalize-send-payment-link-body.util';

export type VoicePaymentProductRequest = {
  productName?: string;
  variantId?: string;
  quantity: number;
};

const ARRAY_KEYS = ['products', 'items', 'books', 'lineItems', 'line_items'];
const NAME_KEYS = [
  'productName',
  'product_name',
  'productTitle',
  'product_title',
  'bookTitle',
  'book_title',
  'title',
  'name',
  'isbn',
  'query',
];
const VARIANT_KEYS = ['variantId', 'variant_id'];

/** 10 or 13 digit run (ISBN), tolerating spaces/hyphens between digits. */
const ISBN_CANDIDATE_REGEX = /(?:\d[\s-]?){9,12}\d/g;

function coerceQuantity(value: unknown, fallback = 1): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, Math.trunc(value));
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(1, Math.trunc(n));
  }
  return fallback;
}

function fromArrayEntry(entry: unknown): VoicePaymentProductRequest | null {
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    return trimmed ? { productName: trimmed, quantity: 1 } : null;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;

  const record = entry as Record<string, unknown>;
  const productName = pickString(record, NAME_KEYS);
  const variantId = pickString(record, VARIANT_KEYS);
  if (!productName && !variantId) return null;

  return {
    productName: productName || undefined,
    variantId: variantId || undefined,
    quantity: coerceQuantity(record.quantity ?? record.qty ?? record.copies),
  };
}

/**
 * Split a single spoken query containing MULTIPLE ISBNs into separate product requests.
 * Only splits when 2+ ISBN-like digit runs are present — regular titles stay intact
 * (e.g. "1984 and Animal Farm" is NOT split; "9780143127550 and 9780735211292" is).
 */
export function splitMultiIsbnQuery(raw: string): string[] {
  const text = (raw ?? '').trim();
  if (!text) return [];

  const matches = [...text.matchAll(ISBN_CANDIDATE_REGEX)]
    .map((m) => m[0].replace(/[\s-]/g, ''))
    .filter((digits) => digits.length === 10 || digits.length === 13);

  const unique = [...new Set(matches)];
  if (unique.length < 2) return [text];
  return unique;
}

/**
 * Resolve ALL products requested in one SendPaymentLink call.
 * Sources (in priority order):
 *  1. `products` / `items` / `books` array — objects or plain strings
 *  2. single productName/variantId fields — productName with multiple ISBNs is auto-split
 */
export function resolveVoicePaymentProducts(args: {
  flat: Record<string, unknown>;
  body: Record<string, unknown>;
  singleProductName?: string;
  singleVariantId?: string;
  singleQuantity?: number;
}): VoicePaymentProductRequest[] {
  for (const key of ARRAY_KEYS) {
    const candidate = args.flat[key] ?? args.body[key];
    const list = Array.isArray(candidate)
      ? candidate
      : typeof candidate === 'string' && candidate.trim().startsWith('[')
        ? safeParseArray(candidate)
        : null;
    if (list && list.length > 0) {
      const items = list
        .map((entry) => fromArrayEntry(entry))
        .filter((item): item is VoicePaymentProductRequest => item !== null);
      if (items.length > 0) return items;
    }
  }

  const name = args.singleProductName?.trim();
  const variantId = args.singleVariantId?.trim();
  const quantity = Math.max(1, args.singleQuantity ?? 1);

  if (name) {
    const split = splitMultiIsbnQuery(name);
    if (split.length > 1) {
      return split.map((isbn) => ({ productName: isbn, quantity: 1 }));
    }
    return [{ productName: name, variantId: variantId || undefined, quantity }];
  }

  if (variantId) {
    return [{ variantId, quantity }];
  }

  return [];
}

function safeParseArray(raw: string): unknown[] | null {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
