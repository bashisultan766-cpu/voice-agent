import { normalizeBookTitleForSearch, expandQueryTokens } from '../ranking/bookstore-title-normalizer.util';
import { cleanVoiceProductQuery } from '../../agents/voice-product-query.util';

export type RealtimeSearchKind = 'title' | 'isbn' | 'barcode' | 'sku' | 'mixed';

const ISBN_RE = /\b(?:97[89][-\s]?\d{1,5}[-\s]?\d{1,7}[-\s]?\d{1,6}[-\s]?\d|[0-9]{9}[0-9Xx]|[0-9]{13})\b/;

export type ParsedRealtimeQuery = {
  raw: string;
  normalized: string;
  kind: RealtimeSearchKind;
  isbn?: string;
  barcode?: string;
  sku?: string;
  probableTitle: string;
  cleanedQuery: string;
  typoVariants: string[];
};

export function parseRealtimeSearchQuery(raw: string): ParsedRealtimeQuery {
  const trimmed = raw.trim();
  const isbnMatch = trimmed.match(ISBN_RE);
  const isbn = isbnMatch?.[0]?.replace(/[^0-9Xx]/gi, '').toUpperCase();
  const { cleanedQuery, probableTitle } = cleanVoiceProductQuery(trimmed);
  const normalized = normalizeBookTitleForSearch(probableTitle || cleanedQuery || trimmed);

  let kind: RealtimeSearchKind = 'title';
  let barcode: string | undefined;
  let sku: string | undefined;

  if (isbn && (isbn.length === 10 || isbn.length === 13)) {
    kind = 'isbn';
  } else if (/^\d{8,14}$/.test(trimmed.replace(/\D/g, '')) && trimmed.replace(/\D/g, '').length >= 8) {
    kind = 'barcode';
    barcode = trimmed.replace(/\D/g, '');
  } else {
    const skuExplicit = trimmed.match(/\bsku\s*[:#]?\s*([A-Z0-9][A-Z0-9\-_.]{2,24})\b/i);
    const compactCode = trimmed.replace(/\s/g, '');
    if (skuExplicit?.[1]) {
      kind = 'sku';
      sku = skuExplicit[1].toUpperCase();
    } else if (/^[A-Z0-9][A-Z0-9\-_.]{3,24}$/i.test(compactCode) && !/\s/.test(trimmed)) {
      kind = 'sku';
      sku = compactCode.toUpperCase();
    }
  }

  const typoVariants = [
    normalized,
    ...expandQueryTokens(probableTitle || cleanedQuery || trimmed).map(normalizeBookTitleForSearch),
  ].filter(Boolean);

  const uniqueVariants = [...new Set(typoVariants)].slice(0, 8);

  return {
    raw: trimmed,
    normalized,
    kind,
    isbn,
    barcode,
    sku,
    probableTitle,
    cleanedQuery,
    typoVariants: uniqueVariants,
  };
}

export function primarySearchTerm(parsed: ParsedRealtimeQuery): string {
  if (parsed.kind === 'isbn' && parsed.isbn) return parsed.isbn;
  if (parsed.kind === 'barcode' && parsed.barcode) return parsed.barcode;
  if (parsed.kind === 'sku' && parsed.sku) return parsed.sku;
  return parsed.probableTitle || parsed.cleanedQuery || parsed.raw;
}
