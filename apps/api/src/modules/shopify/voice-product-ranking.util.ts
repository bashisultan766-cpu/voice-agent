import {
  generateTypoQueryVariants,
  normalizeVoiceText,
  splitMultilingualTitleFragments,
  tokenizeNormalized,
} from './voice-text-normalize.util';

export type VoiceProductScoreBreakdown = {
  exactSku: boolean;
  exactIsbn: boolean;
  exactTitle: boolean;
  titleStartsWith: boolean;
  allTokens: boolean;
  fuzzyOverlap: number;
  inStockBoost: number;
  inventoryBoost: number;
  matchedFragment: string | null;
  baseScore: number;
};

export type RankableVoiceProduct = {
  productId: string;
  variantId: string;
  title: string;
  price: string | null;
  inventory: number;
  image: string | null;
  sku: string | null;
  inStock: boolean;
  skus: string[];
  barcodes: string[];
};

export type RankedVoiceProduct = RankableVoiceProduct & {
  score: number;
  scoreBreakdown: VoiceProductScoreBreakdown;
  normalizedTitle: string;
  matchedTokens: string[];
};

export type VoiceRankingDiagnostics = {
  normalizedQuery: string;
  queryTokens: string[];
  typoVariants: string[];
  topScore: number | null;
  rankedCount: number;
};

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) row[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

function tokenMatchesQueryToken(queryToken: string, titleToken: string): boolean {
  if (!queryToken || !titleToken) return false;
  if (queryToken === titleToken) return true;
  if (queryToken.length >= 4 && titleToken.length >= 4 && levenshtein(queryToken, titleToken) <= 1) {
    return true;
  }
  if (queryToken.length >= 3 && titleToken.startsWith(queryToken)) return true;
  return false;
}

function expandQueryTokens(rawQuery: string): string[] {
  const tokens = new Set<string>();
  for (const variant of generateTypoQueryVariants(rawQuery, 2)) {
    for (const t of tokenizeNormalized(variant)) {
      tokens.add(t);
    }
  }
  return [...tokens];
}

function scoreAgainstFragment(
  normalizedQuery: string,
  queryTokens: string[],
  normalizedFragment: string,
  fragmentTokens: string[],
  product: RankableVoiceProduct,
  normalizedIsbn: string | null,
): { score: number; breakdown: VoiceProductScoreBreakdown; matchedTokens: string[] } {
  const matchedTokens = queryTokens.filter((qt) =>
    fragmentTokens.some((ft) => tokenMatchesQueryToken(qt, ft)),
  );

  const skusNorm = product.skus.map((s) => normalizeVoiceText(s));
  const barcodesNorm = product.barcodes.map((b) => b.replace(/[^0-9Xx]/gi, '').toUpperCase());

  const exactSku =
    looksLikeSkuQuery(normalizedQuery) &&
    skusNorm.some((s) => s === normalizedQuery || s.replace(/\s/g, '') === normalizedQuery.replace(/\s/g, ''));
  const exactIsbn =
    Boolean(normalizedIsbn) &&
    barcodesNorm.some((b) => b === normalizedIsbn || b.endsWith(normalizedIsbn!));

  const exactTitle = normalizedFragment === normalizedQuery && normalizedQuery.length > 0;
  const titleStartsWith =
    !exactTitle &&
    normalizedQuery.length >= 3 &&
    (normalizedFragment.startsWith(normalizedQuery) || normalizedQuery.startsWith(normalizedFragment));
  const allTokens =
    queryTokens.length > 0 &&
    queryTokens.every((qt) => fragmentTokens.some((ft) => tokenMatchesQueryToken(qt, ft)));

  const fuzzyOverlap =
    queryTokens.length > 0 ? matchedTokens.length / queryTokens.length : 0;

  let baseScore = 0;
  if (exactSku) baseScore = 100;
  else if (exactIsbn) baseScore = 98;
  else if (exactTitle) baseScore = 96;
  else if (titleStartsWith) baseScore = 90;
  else if (allTokens) baseScore = 82;
  else if (fuzzyOverlap >= 0.5) baseScore = Math.round(40 + fuzzyOverlap * 35);
  else if (fuzzyOverlap > 0) baseScore = Math.round(20 + fuzzyOverlap * 25);

  const inStockBoost = product.inStock ? 3 : 0;
  const inventoryBoost = product.inStock ? Math.min(5, Math.floor(product.inventory / 10)) : 0;
  const score = Math.min(100, baseScore + inStockBoost + inventoryBoost);

  return {
    score,
    matchedTokens,
    breakdown: {
      exactSku,
      exactIsbn,
      exactTitle,
      titleStartsWith,
      allTokens,
      fuzzyOverlap: Math.round(fuzzyOverlap * 100) / 100,
      inStockBoost,
      inventoryBoost,
      matchedFragment: normalizedFragment || null,
      baseScore,
    },
  };
}

function looksLikeSkuQuery(normalizedQuery: string): boolean {
  return normalizedQuery.length >= 3 && normalizedQuery.length <= 64 && !/\s/.test(normalizedQuery);
}

function rankOneProduct(
  rawQuery: string,
  product: RankableVoiceProduct,
  normalizedIsbn: string | null,
): RankedVoiceProduct {
  const normalizedQuery = normalizeVoiceText(rawQuery);
  const queryTokens = expandQueryTokens(rawQuery);
  const fragments = splitMultilingualTitleFragments(product.title);

  let best: {
    score: number;
    breakdown: VoiceProductScoreBreakdown;
    matchedTokens: string[];
    normalizedTitle: string;
  } | null = null;

  for (const fragment of fragments) {
    const normalizedFragment = normalizeVoiceText(fragment);
    const fragmentTokens = tokenizeNormalized(fragment);
    const result = scoreAgainstFragment(
      normalizedQuery,
      queryTokens,
      normalizedFragment,
      fragmentTokens,
      product,
      normalizedIsbn,
    );
    if (!best || result.score > best.score) {
      best = {
        score: result.score,
        breakdown: result.breakdown,
        matchedTokens: result.matchedTokens,
        normalizedTitle: normalizedFragment,
      };
    }
  }

  if (!best) {
    best = {
      score: 0,
      breakdown: {
        exactSku: false,
        exactIsbn: false,
        exactTitle: false,
        titleStartsWith: false,
        allTokens: false,
        fuzzyOverlap: 0,
        inStockBoost: 0,
        inventoryBoost: 0,
        matchedFragment: null,
        baseScore: 0,
      },
      matchedTokens: [],
      normalizedTitle: normalizeVoiceText(product.title),
    };
  }

  return {
    ...product,
    score: best.score,
    scoreBreakdown: best.breakdown,
    normalizedTitle: best.normalizedTitle,
    matchedTokens: best.matchedTokens,
  };
}

export function rankVoiceProducts(
  rawQuery: string,
  products: RankableVoiceProduct[],
  normalizedIsbn: string | null,
  limit: number,
): { products: RankedVoiceProduct[]; diagnostics: VoiceRankingDiagnostics } {
  const normalizedQuery = normalizeVoiceText(rawQuery);
  const queryTokens = expandQueryTokens(rawQuery);
  const typoVariants = generateTypoQueryVariants(rawQuery, 2);

  const ranked = products
    .map((p) => rankOneProduct(rawQuery, p, normalizedIsbn))
    .filter((p) => p.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.inventory !== a.inventory) return b.inventory - a.inventory;
      return a.title.localeCompare(b.title);
    });

  const sliced = ranked.slice(0, limit);

  return {
    products: sliced,
    diagnostics: {
      normalizedQuery,
      queryTokens,
      typoVariants,
      topScore: sliced[0]?.score ?? null,
      rankedCount: ranked.length,
    },
  };
}
