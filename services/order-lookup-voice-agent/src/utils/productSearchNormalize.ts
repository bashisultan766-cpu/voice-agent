/** Normalize text for product search — lowercase, strip punctuation, collapse spaces. */
export function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  return normalizeSearchText(text)
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Token-based title scoring:
 * +3 full phrase match
 * +2 all query tokens present in title
 * +1 per partial token match (prefix/substring)
 */
export function scoreTitleMatch(title: string, query: string): number {
  const normalizedTitle = normalizeSearchText(title);
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  let score = 0;

  if (normalizedTitle === normalizedQuery) return 10;
  if (normalizedTitle.includes(normalizedQuery)) score += 3;

  const queryTokens = tokenize(normalizedQuery);
  const titleTokens = new Set(tokenize(normalizedTitle));
  if (!queryTokens.length) return score;

  let fullTokenHits = 0;
  let partialHits = 0;

  for (const token of queryTokens) {
    if (titleTokens.has(token)) {
      fullTokenHits++;
      continue;
    }
    const partial = [...titleTokens].some(
      (tt) => tt.includes(token) || token.includes(tt),
    );
    if (partial) partialHits++;
  }

  if (fullTokenHits === queryTokens.length) score += 2;
  else score += fullTokenHits > 0 ? 1 : 0;

  score += partialHits * 0.5;
  return score;
}

export function rankBySearchScore<T extends { title: string }>(
  items: T[],
  query: string,
  minScore = 1,
): Array<T & { searchScore: number }> {
  return items
    .map((item) => ({ ...item, searchScore: scoreTitleMatch(item.title, query) }))
    .filter((item) => item.searchScore >= minScore)
    .sort((a, b) => b.searchScore - a.searchScore);
}

/** ISBN-10 and ISBN-13 normalization — strips hyphens/spaces, uppercases check digit. */
export function normalizeIsbn(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

export function isValidIsbnFormat(isbn: string): boolean {
  const n = normalizeIsbn(isbn);
  return /^\d{9}[\dX]$/.test(n) || /^97[89]\d{9}[\dX]$/.test(n);
}

/** Return lookup variants (ISBN-10 + ISBN-13) when convertible. */
export function isbnLookupVariants(raw: string): string[] {
  const normalized = normalizeIsbn(raw);
  const variants = new Set<string>([normalized]);

  if (/^97[89]\d{9}[\dX]$/.test(normalized)) {
    const core = normalized.slice(3, 12);
    variants.add(core);
  }

  if (/^\d{9}[\dX]$/.test(normalized)) {
    const prefix = "978" + normalized.slice(0, 9);
    const check = isbn13CheckDigit(prefix);
    variants.add(prefix + check);
  }

  return [...variants];
}

function isbn13CheckDigit(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = Number(first12[i]);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  const mod = (10 - (sum % 10)) % 10;
  return String(mod);
}

const SPOKEN_DIGIT_WORDS: Record<string, string> = {
  zero: "0",
  oh: "0",
  o: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

/** Collapse spoken or spaced digits into one string (voice STT friendly). */
export function digitizeSpeechForIsbn(text: string): string {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .split(/\s+/)
    .filter(Boolean);

  let out = "";
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      out += token;
      continue;
    }
    const digit = SPOKEN_DIGIT_WORDS[token];
    if (digit !== undefined) out += digit;
  }
  return out;
}

function pickValidIsbnFromDigitString(digits: string): string | null {
  if (!digits) return null;

  if (digits.length === 13 && isValidIsbnFormat(digits)) return normalizeIsbn(digits);
  if (digits.length === 10 && isValidIsbnFormat(digits)) return normalizeIsbn(digits);

  const isbn13Match = digits.match(/97[89]\d{10}/);
  if (isbn13Match && isValidIsbnFormat(isbn13Match[0])) {
    return normalizeIsbn(isbn13Match[0]);
  }

  if (digits.length > 13) {
    const tail13 = digits.slice(-13);
    if (isValidIsbnFormat(tail13)) return normalizeIsbn(tail13);
  }

  if (digits.length > 10) {
    const tail10 = digits.slice(-10);
    if (isValidIsbnFormat(tail10)) return normalizeIsbn(tail10);
  }

  return null;
}

/**
 * Extract ISBN from voice transcript — handles compact, spaced, and spoken-digit forms.
 */
export function extractIsbnFromSpeech(text: string): string | null {
  const compact = normalizeIsbn(text);
  if (compact.length === 10 || compact.length === 13) {
    if (isValidIsbnFormat(compact)) return compact;
  }

  const isbn13 = text.match(/\b97[89][\d\s-]{10,25}[\dXx]\b/);
  if (isbn13) {
    const candidate = normalizeIsbn(isbn13[0]);
    if (isValidIsbnFormat(candidate)) return candidate;
  }

  const isbn10 = text.match(/\b[\dXx][\d\s-]{8,16}[\dXx]\b/);
  if (isbn10) {
    const candidate = normalizeIsbn(isbn10[0]);
    if (isValidIsbnFormat(candidate)) return candidate;
  }

  const labeled = text.match(/\bisbn\s*#?\s*([\dXx\s-]{10,25})\b/i);
  if (labeled?.[1]) {
    const candidate = normalizeIsbn(labeled[1]);
    if (isValidIsbnFormat(candidate)) return candidate;
  }

  const spokenDigits = digitizeSpeechForIsbn(text);
  const fromSpoken = pickValidIsbnFromDigitString(spokenDigits);
  if (fromSpoken) return fromSpoken;

  const packedDigits = text.replace(/\D/g, "");
  return pickValidIsbnFromDigitString(packedDigits);
}

export function tagOverlapScore(tagsA: string[], tagsB: string[]): number {
  const setB = new Set(tagsB.map((t) => normalizeSearchText(t)));
  return tagsA.reduce((sum, tag) => sum + (setB.has(normalizeSearchText(tag)) ? 1 : 0), 0);
}

/** Check if product matches normalized ISBN via metafields, SKU, or barcode. */
export function productMatchesIsbn(product: { isbns?: string[]; variants: Array<{ sku?: string; barcode?: string }> }, isbn: string): boolean {
  const target = normalizeIsbn(isbn);
  for (const value of product.isbns ?? []) {
    if (normalizeIsbn(value) === target) return true;
  }
  for (const variant of product.variants) {
    if (variant.sku && normalizeIsbn(variant.sku) === target) return true;
    if (variant.barcode && normalizeIsbn(variant.barcode) === target) return true;
    if (variant.sku && normalizeIsbn(variant.sku).includes(target) && target.length >= 8) return true;
    if (variant.barcode && normalizeIsbn(variant.barcode).includes(target) && target.length >= 8) return true;
  }
  return false;
}

/**
 * Post-fetch ranking (Shopify live data only):
 * +3 exact title / ISBN match
 * +2 partial title match
 * +1 weak token overlap
 */
export function scoreLiveProduct(
  product: { title: string; isbns?: string[]; variants: Array<{ sku?: string; barcode?: string }> },
  query: string,
  queryIsbn?: string,
): number {
  let score = 0;
  const normTitle = normalizeSearchText(product.title);
  const normQuery = normalizeSearchText(query);

  if (normQuery && normTitle === normQuery) score += 3;
  else if (normQuery && normTitle.includes(normQuery)) score += 3;
  else {
    const titleScore = scoreTitleMatch(product.title, query);
    if (titleScore >= 3) score += 2;
    else if (titleScore >= 1) score += 1;
  }

  if (queryIsbn) {
    for (const variant of isbnLookupVariants(queryIsbn)) {
      if (productMatchesIsbn(product, variant)) score += 3;
    }
  }

  return score;
}

export function rankLiveProducts<T extends { title: string; isbns?: string[]; variants: Array<{ sku?: string; barcode?: string }> }>(
  products: T[],
  query: string,
  queryIsbn?: string,
): T[] {
  return [...products]
    .map((p) => ({ p, score: scoreLiveProduct(p, query, queryIsbn) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.p)
    .slice(0, 5);
}
