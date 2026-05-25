/**
 * Ranks catalog candidates using tags, genres, inventory, similarity, and bestseller signals.
 * Used at runtime only — does not invent products.
 */

export type RecommendableProduct = {
  productId: string;
  title: string;
  handle?: string | null;
  vendor?: string | null;
  productType?: string | null;
  tags?: string | null;
  variants: Array<{
    variantId: string;
    price: string | null;
    inventoryQuantity: number;
    availableForSale: boolean;
  }>;
  relevanceScore?: number;
  syncedAt?: Date;
};

export type RecommendationPreferences = {
  preferredGenres?: string[];
  mentionedTitles?: string[];
  rejectedTitles?: string[];
  queryTokens?: string[];
};

export type RankedRecommendation = RecommendableProduct & {
  recommendationScore: number;
  matchReasons: string[];
};

const BESTSELLER_TAG_RE = /\b(bestseller|best seller|top seller|featured|staff pick)\b/i;
const GENRE_TAG_RE =
  /\b(fiction|nonfiction|mystery|romance|sci-fi|science fiction|fantasy|biography|history|children|young adult|ya|thriller|poetry|business|self-help)\b/i;

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/\s+/).filter((t) => t.length > 1))];
}

function parseTags(tags: string | null | undefined): string[] {
  if (!tags?.trim()) return [];
  return tags.split(/[,;|]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
}

function inventoryScore(p: RecommendableProduct): number {
  const total = p.variants.reduce((s, v) => s + Math.max(0, v.inventoryQuantity ?? 0), 0);
  const anyAvailable = p.variants.some((v) => v.availableForSale && (v.inventoryQuantity ?? 0) > 0);
  if (!anyAvailable && total <= 0) return 0;
  if (total >= 10) return 1;
  if (total >= 1) return 0.6;
  return 0.2;
}

function genreOverlap(tags: string[], genres: string[]): number {
  if (!genres.length) return 0;
  const tagStr = tags.join(' ');
  let hits = 0;
  for (const g of genres) {
    if (tagStr.includes(g.toLowerCase())) hits += 1;
  }
  return Math.min(1, hits / genres.length);
}

function collectionSimilarity(a: RecommendableProduct, b: RecommendableProduct): number {
  const scoreParts: number[] = [];
  if (a.vendor && b.vendor && a.vendor.toLowerCase() === b.vendor.toLowerCase()) scoreParts.push(0.35);
  if (a.productType && b.productType && a.productType.toLowerCase() === b.productType.toLowerCase()) {
    scoreParts.push(0.35);
  }
  const tagsA = new Set(parseTags(a.tags));
  const tagsB = parseTags(b.tags);
  if (tagsA.size && tagsB.length) {
    const overlap = tagsB.filter((t) => tagsA.has(t)).length;
    scoreParts.push(Math.min(0.3, overlap * 0.1));
  }
  return scoreParts.reduce((s, x) => s + x, 0);
}

function bestsellerBoost(tags: string[]): number {
  const joined = tags.join(' ');
  return BESTSELLER_TAG_RE.test(joined) ? 0.25 : 0;
}

function semanticTokenScore(title: string, tokens: string[]): number {
  if (!tokens.length) return 0;
  const hay = title.toLowerCase();
  let hits = 0;
  for (const tok of tokens) {
    if (hay.includes(tok)) hits += 1;
  }
  return hits / tokens.length;
}

/**
 * Rank products for voice recommendation. Higher score = better to offer first.
 */
export function rankProductRecommendations(
  candidates: RecommendableProduct[],
  prefs: RecommendationPreferences,
  limit = 3,
): RankedRecommendation[] {
  const genres = (prefs.preferredGenres ?? []).map((g) => g.toLowerCase().trim()).filter(Boolean);
  const rejected = new Set((prefs.rejectedTitles ?? []).map((t) => t.toLowerCase().trim()));
  const mentioned = candidates.filter((c) =>
    (prefs.mentionedTitles ?? []).some((m) => c.title.toLowerCase().includes(m.toLowerCase())),
  );
  const queryTokens = prefs.queryTokens ?? [];

  const scored = candidates
    .filter((c) => !rejected.has(c.title.toLowerCase().trim()))
    .map((product) => {
      const tags = parseTags(product.tags);
      const reasons: string[] = [];
      let score = product.relevanceScore ?? 0;

      const inv = inventoryScore(product);
      score += inv * 0.2;
      if (inv >= 0.6) reasons.push('in_stock');

      const genre = genreOverlap(tags, genres);
      if (genre > 0) {
        score += genre * 0.25;
        reasons.push('genre_match');
      } else if (GENRE_TAG_RE.test(tags.join(' '))) {
        score += 0.1;
        reasons.push('tagged_genre');
      }

      const best = bestsellerBoost(tags);
      if (best > 0) {
        score += best;
        reasons.push('bestseller_signal');
      }

      const sem = semanticTokenScore(product.title, queryTokens);
      if (sem > 0) {
        score += sem * 0.2;
        reasons.push('title_match');
      }

      if (mentioned.length) {
        const sim = Math.max(...mentioned.map((m) => collectionSimilarity(product, m)), 0);
        if (sim > 0) {
          score += sim * 0.15;
          reasons.push('collection_similarity');
        }
      }

      const recent =
        product.syncedAt instanceof Date
          ? Math.max(0, 1 - (Date.now() - product.syncedAt.getTime()) / (90 * 24 * 3600 * 1000))
          : 0;
      score += recent * 0.05;

      return {
        ...product,
        recommendationScore: Number(score.toFixed(4)),
        matchReasons: reasons,
      };
    })
    .sort((a, b) => b.recommendationScore - a.recommendationScore);

  return scored.slice(0, limit);
}

export function extractGenrePreferencesFromText(text: string): string[] {
  const t = text.toLowerCase();
  const found: string[] = [];
  const genreMap: Record<string, string> = {
    mystery: 'mystery',
    romance: 'romance',
    'sci-fi': 'sci-fi',
    'science fiction': 'science fiction',
    fantasy: 'fantasy',
    biography: 'biography',
    history: 'history',
    children: 'children',
    thriller: 'thriller',
    poetry: 'poetry',
    fiction: 'fiction',
    nonfiction: 'nonfiction',
  };
  for (const [needle, genre] of Object.entries(genreMap)) {
    if (t.includes(needle)) found.push(genre);
  }
  return [...new Set(found)];
}
