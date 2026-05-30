import type { VoiceProductScoreBreakdown } from '../voice-product-ranking.util';

/** Lean product payload for ElevenLabs / Twilio voice agents. */
export type VoiceCatalogProduct = {
  productId: string;
  variantId: string;
  title: string;
  price: string | null;
  inventory: number;
  image: string | null;
  sku: string | null;
  inStock: boolean;
  score: number;
  scoreBreakdown?: VoiceProductScoreBreakdown;
  matchedTokens?: string[];
  normalizedTitle?: string;
};

export type ShopifySearchResult = {
  products: VoiceCatalogProduct[];
  shopifyLatencyMs: number;
  queriesTried: string[];
  normalizedQuery: string;
  ranking?: {
    normalizedQuery: string;
    queryTokens: string[];
    typoVariants: string[];
    topScore: number | null;
    rankedCount: number;
  };
};
