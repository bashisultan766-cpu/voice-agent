/**
 * Build parallel Shopify Admin `products(query:)` strings for voice search.
 */

import { generateTypoQueryVariants, normalizeVoiceText } from './voice-text-normalize.util';

const ISBN_DIGITS_RE = /\b(?:97[89])?\d{9}[\dXx]\b|\b\d{13}\b|\b\d{10}\b/;

export function extractIsbnDigits(raw: string): string | null {
  const match = raw.match(ISBN_DIGITS_RE);
  if (!match) return null;
  const digits = match[0].replace(/[^0-9Xx]/g, '').toUpperCase();
  if (digits.length === 10 || digits.length === 13) return digits;
  return null;
}

export function looksLikeSku(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 3 || t.length > 64) return false;
  if (/\s/.test(t)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t);
}

function escapeShopifyQueryTerm(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Parallel Admin search queries — ISBN/SKU first, then title + token AND + broad.
 */
export function buildShopifyProductSearchQueries(rawQuery: string, maxQueries = 4): string[] {
  const trimmed = rawQuery.trim();
  if (!trimmed) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  const push = (q: string) => {
    const key = q.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(q.trim());
  };

  const isbn = extractIsbnDigits(trimmed);
  if (isbn) {
    push(`barcode:${isbn}`);
    push(`sku:${isbn}`);
  }
  if (looksLikeSku(trimmed)) {
    push(`sku:${trimmed}`);
  }

  const variants = generateTypoQueryVariants(trimmed, 1);
  const primary = variants[0] ?? trimmed;
  const escaped = escapeShopifyQueryTerm(primary);
  push(`title:"${escaped}"`);

  const tokens = normalizeVoiceText(primary).split(' ').filter((t) => t.length >= 3);
  if (tokens.length >= 2) {
    push(tokens.join(' AND '));
  }

  push(`"${escaped}"`);
  push(primary);

  for (const variant of variants.slice(1)) {
    if (out.length >= maxQueries) break;
    push(`title:"${escapeShopifyQueryTerm(variant)}"`);
  }

  return out.slice(0, maxQueries);
}
