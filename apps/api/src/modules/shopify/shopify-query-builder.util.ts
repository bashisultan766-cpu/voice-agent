/**
 * Build parallel Shopify Admin `products(query:)` strings for voice search.
 */

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

/** Up to 4 parallel Admin search queries (title, ISBN/barcode, SKU, broad). */
export function buildShopifyProductSearchQueries(rawQuery: string): string[] {
  const query = rawQuery.trim();
  if (!query) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  const push = (q: string) => {
    const key = q.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(q.trim());
  };

  const escaped = escapeShopifyQueryTerm(query);
  push(`title:"${escaped}"`);
  push(`"${escaped}"`);

  const isbn = extractIsbnDigits(query);
  if (isbn) {
    push(`barcode:${isbn}`);
    push(`sku:${isbn}`);
  }

  if (looksLikeSku(query)) {
    push(`sku:${query}`);
  }

  push(query);
  return out.slice(0, 4);
}
