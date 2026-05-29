import type { ShopifyProductSummary, ShopifyProductSearchVoiceLog } from '../../agents/shopify-agent.service';

/** Voice commerce confidence bands for auto-confirm vs clarify vs repeat. */
export type BookstoreConfidenceTier = 'HIGH' | 'MEDIUM' | 'LOW';

export interface BookstoreRankedProduct {
  productId: string;
  title: string;
  handle?: string | null;
  vendor?: string | null;
  productType?: string | null;
  tags?: string[];
  isbn?: string | null;
  variants: ShopifyProductSummary['variants'];
  relevanceScore: number;
  matchReason: string;
  compositeScore: number;
  confidenceTier: BookstoreConfidenceTier;
  seriesKey?: string | null;
  volumeNumber?: number | null;
}

export interface BookstoreSearchDiagnostics {
  fuzzySearchActivated: boolean;
  semanticSearchUsed: boolean;
  cacheHit: boolean;
  memoryHit: boolean;
  redisHit?: boolean;
  searchLatencyMs: number;
  shopifyLatencyMs?: number;
  semanticRankingLatencyMs?: number;
  cacheLookupMs?: number;
  indexLoadMs?: number;
  totalVoiceTurnLatencyMs?: number;
  confidenceTier: BookstoreConfidenceTier;
  topResultConfidence: number;
  recommendedBooks: Array<{ title: string; score: number; matchReason: string; vendor?: string | null }>;
  rankingDiagnostics: Array<{ title: string; tokenOverlap: number; levenshtein: number; semantic: number; authorBoost: number }>;
  debounced: boolean;
  parallelShopifyQueries: number;
  indexSize: number;
  slowPath?: boolean;
  shopifyRetryCount?: number;
}

export interface BookstoreVoiceSearchResult {
  ok: boolean;
  products?: ShopifyProductSummary[];
  voiceSummary?: string;
  error?: string;
  searchVoiceLog?: ShopifyProductSearchVoiceLog & {
    bookstoreSearch?: BookstoreSearchDiagnostics;
    confidenceTier?: BookstoreConfidenceTier;
  };
}

export interface BookstoreIndexProduct {
  productId: string;
  title: string;
  handle: string | null;
  vendor: string | null;
  productType: string | null;
  tags: string | null;
  normalizedTitle: string;
  normalizedAuthor: string;
  seriesKey: string | null;
  volumeNumber: number | null;
  embedding: Float32Array;
  authorEmbedding: Float32Array;
  categoryEmbedding: Float32Array;
}
